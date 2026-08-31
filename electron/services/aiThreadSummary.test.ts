import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DATA_BOUNDARY_START, DATA_BOUNDARY_END } from '../../packages/core'
import type { AiActionLogEntry, AiCostReservation, ThreadSummaryRow } from '../../packages/db'
import type {
  ThreadSummaryDeps,
  ThreadSummaryMessage,
  ThreadSummaryOptions,
  SummaryChatResult,
} from './aiThreadSummary'

// ── ABI-safe self-skip probe ─────────────────────────────────────────────────
//
// better-sqlite3 is a native module. When node_modules were built for Electron's
// ABI (NODE_MODULE_VERSION 148 on Electron 43) but vitest runs on the system Node
// (127), loading
// packages/db crashes at import time because packages/db/index.ts unconditionally
// runs `new Database(dbPath)` at module load.
//
// This suite drives the REAL generator (generateThreadSummary), and both the
// generator module (electron/services/aiThreadSummary.ts) AND this file import
// value symbols (computeThreadHash / upsertThreadSummary) from packages/db at the
// top level — so a naive top-level import would crash the whole *collection*
// (not a clean self-skip) under an ABI mismatch.
//
// Mirror the packages/db/index.test.ts idiom: probe better-sqlite3 in isolation,
// import the db-dependent modules only when the ABI is usable, and gate every test
// behind `testDb = betterSqlite3Usable ? it : it.skip`. This keeps `npm test` green
// in ANY ABI state (self-skip under Electron ABI; real execution under Node ABI),
// per CLAUDE.md §5 Testing.
let betterSqlite3Usable = true
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}
const testDb = betterSqlite3Usable ? it : it.skip

// ── Test harness ────────────────────────────────────────────────────────────
//
// Drives the REAL generator (generateThreadSummary) with injected fakes so a
// regression that skips wrapUntrusted, calls the provider on a cache hit,
// double-writes the audit row, or drops the exactly-5-bullets contract turns a
// test red — no real DB, no real provider, no real telemetry.
//
// We spy on the canonical packages/core wrapUntrusted so a test can assert it
// was invoked once per message body AND that the built prompt actually encloses
// every body between the untrusted-data boundary markers.

const wrapSpy = vi.fn((text: string) => `${DATA_BOUNDARY_START}\n${text}\n${DATA_BOUNDARY_END}`)

vi.mock('../../packages/core', async (importActual) => {
  const actual = await importActual<typeof import('../../packages/core')>()
  return {
    ...actual,
    // Route the generator's boundary wrap through the spy while preserving the
    // real marker vocabulary (so prompt-content assertions stay meaningful).
    wrapUntrusted: (text: string) => wrapSpy(text),
  }
})

// The generator's cache read/write go through injected deps (deps.getCached /
// deps.upsert fakes), so no real DB is touched by the generation path. But the
// generator module itself value-imports packages/db (computeThreadHash /
// upsertThreadSummary) at its top level, so importing it eagerly would crash the
// collection under an ABI mismatch. Import BOTH the generator and the db helper
// ONLY when better-sqlite3 is usable; otherwise fall back to stubs. Every test
// that touches these symbols is gated behind `testDb`, so under a mismatch the
// stubs are never exercised — they exist purely to keep the top-level bindings
// well-typed without triggering the native-module load.
type GeneratorModule = typeof import('./aiThreadSummary')
type DbModule = typeof import('../../packages/db')

let generateThreadSummary: GeneratorModule['generateThreadSummary']
let buildSummaryUserPrompt: GeneratorModule['buildSummaryUserPrompt']
let parseSummaryResponse: GeneratorModule['parseSummaryResponse']
let normalizeBullets: GeneratorModule['normalizeBullets']
let SUMMARY_BULLET_COUNT: GeneratorModule['SUMMARY_BULLET_COUNT']
let MIN_SUMMARY_MESSAGES: GeneratorModule['MIN_SUMMARY_MESSAGES']
// The generator recomputes the identity hash via the REAL db-layer
// computeThreadHash (a pure SHA-256 helper). Import it here so recompute tests
// can assert the generator keyed the cache/upsert on exactly that value — the
// same symbol the generator uses, not a re-implementation that could drift.
let computeThreadHash: DbModule['computeThreadHash']

if (betterSqlite3Usable) {
  const gen = await import('./aiThreadSummary')
  generateThreadSummary = gen.generateThreadSummary
  buildSummaryUserPrompt = gen.buildSummaryUserPrompt
  parseSummaryResponse = gen.parseSummaryResponse
  normalizeBullets = gen.normalizeBullets
  SUMMARY_BULLET_COUNT = gen.SUMMARY_BULLET_COUNT
  MIN_SUMMARY_MESSAGES = gen.MIN_SUMMARY_MESSAGES
  ;({ computeThreadHash } = await import('../../packages/db'))
} else {
  // Unreachable stubs: no `testDb` test runs under an ABI mismatch, but the
  // bindings must be defined so the (skipped) test bodies still type-check.
  const unreachable = () => { throw new Error('db module unavailable (ABI mismatch) — this suite self-skips') }
  generateThreadSummary = unreachable as unknown as GeneratorModule['generateThreadSummary']
  buildSummaryUserPrompt = unreachable as unknown as GeneratorModule['buildSummaryUserPrompt']
  parseSummaryResponse = unreachable as unknown as GeneratorModule['parseSummaryResponse']
  normalizeBullets = unreachable as unknown as GeneratorModule['normalizeBullets']
  SUMMARY_BULLET_COUNT = 5 as unknown as GeneratorModule['SUMMARY_BULLET_COUNT']
  MIN_SUMMARY_MESSAGES = 3 as unknown as GeneratorModule['MIN_SUMMARY_MESSAGES']
  computeThreadHash = unreachable as unknown as DbModule['computeThreadHash']
}

interface Recorded {
  /** Records the (provider, systemPrompt, userPrompt) of each pinned chat call. */
  chatCalls: Array<{ provider: string; systemPrompt: string; userPrompt: string }>
  upserts: Array<{ threadHash: string; accountId: string; oneLine: string; bullets: string[]; provider: string }>
  /** Account-scoped cache-lookup calls: exactly what accountId + hash were queried. */
  cacheLookups: Array<{ accountId: string; threadHash: string }>
  audit: AiActionLogEntry[]
  /** §2.51 admission attempts (one per generation that reaches the budget gate). */
  admits: number
  /** Reservations SETTLED with an actual cost (reconcile to the real amount). */
  settled: Array<{ reservationId: number; actualUsd: number }>
  /** Reservations RELEASED with no spend (reconcile to 0). */
  released: number[]
  /**
   * Ordered trace of the budget/provider interaction, so a test can assert the
   * reservation is taken BEFORE the model call (the whole point of §2.51) and
   * not merely that both happened.
   */
  order: Array<'admit' | 'chat' | 'settle' | 'release'>
  spans: Array<{
    provider: string
    wasLocal: boolean
    tokensIn: number | null
    tokensOut: number | null
    latencyMs: number
    errorClass: 'none' | 'provider_error' | 'parse_error'
  }>
}

interface HarnessOptions {
  /** Cache row returned by getCached, or undefined for a MISS. */
  cached?: ThreadSummaryRow
  /**
   * Cache row keyed by accountId — lets a test assert account-scoped lookups
   * (account A hits, account B misses on the SAME hash). Takes precedence over
   * `cached` when present.
   */
  cachedByAccount?: Record<string, ThreadSummaryRow>
  /**
   * Model text to return in a `billed` outcome, or null to simulate a PROVABLY
   * unbilled provider failure (`{ kind: 'unbilled' }` — no key / non-2xx /
   * pre-dispatch error), which is the only outcome that may release the hold.
   */
  respond?: string | null
  /**
   * §2.51.f2 — the chat dep reports an AMBIGUOUS outcome: the request WAS
   * dispatched and the transport then failed, so the provider may already have
   * generated and billed the completion. The generator must KEEP its
   * conservative floor (no settle, no release).
   */
  chatAmbiguous?: boolean
  /** Provider chat throws instead of returning an outcome. */
  chatThrows?: boolean
  /**
   * §2.51.f2 iteration 7 — is this generation allowed to invent money it cannot
   * measure? Defaults to true (a paid endpoint); false models SELF-HOSTED
   * inference, where an unpriceable completion settles at 0 and an ambiguous
   * failure releases the hold rather than keeping a floor.
   */
  allowFabrication?: boolean
  usage?: SummaryChatResult['usage']
  model?: string
  /**
   * §2.51 — the atomic admission DENIES this call because the reservation would
   * breach the daily/monthly cap (`{ ok:false, reason:'over-cap' }`). An
   * ordinary budget refusal: no row booked, no provider call.
   */
  overCap?: boolean
  /**
   * §2.51 — the METER itself is broken: `admitBudget` THROWS (invalid amount /
   * ledger-write failure). Must be FAIL-CLOSED, i.e. deny the call — the
   * behaviour that was fail-open before this task (the cost write was merely
   * best-effort AFTER the call and a failure was swallowed).
   */
  admitThrows?: boolean
  /** upsert throws (cache-write failure — non-fatal). */
  upsertThrows?: boolean
  /** Fixed cost returned by estimateCost (default derives a positive value). */
  estimatedCost?: number | undefined
  now?: () => number
}

/** The reservation handle the fake admission hands back (shape of the real
 *  `AiCostReservation` token so settle/release assertions are meaningful). */
const FAKE_RESERVATION: AiCostReservation = {
  id: 4242,
  reservedUsd: 0.05,
  sessionId: '__ai_cost_ledger__',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function makeHarness(opts: HarnessOptions = {}): { deps: ThreadSummaryDeps; rec: Recorded } {
  const rec: Recorded = {
    chatCalls: [], upserts: [], cacheLookups: [], audit: [],
    admits: 0, settled: [], released: [], order: [], spans: [],
  }
  let clock = 1_000
  const deps: ThreadSummaryDeps = {
    allowFabrication: opts.allowFabrication ?? true,
    getCached: (accountId, threadHash) => {
      rec.cacheLookups.push({ accountId, threadHash })
      if (opts.cachedByAccount) return opts.cachedByAccount[accountId]
      return opts.cached
    },
    upsert: (row) => {
      if (opts.upsertThrows) throw new Error('cache write failed')
      rec.upserts.push(row)
      return { ...row, createdAt: 12345 }
    },
    chat: async (provider, systemPrompt, userPrompt) => {
      rec.chatCalls.push({ provider, systemPrompt, userPrompt })
      rec.order.push('chat')
      if (opts.chatThrows) throw new Error('provider blew up')
      if (opts.chatAmbiguous) return { kind: 'ambiguous', reason: 'transport' }
      if (opts.respond === null) return { kind: 'unbilled', reason: 'rejected' }
      return {
        kind: 'billed',
        result: {
          text: opts.respond ?? defaultResponse(),
          model: opts.model ?? 'test-model',
          usage: opts.usage === undefined ? { inputTokens: 100, outputTokens: 40 } : opts.usage,
        },
      }
    },
    admitBudget: () => {
      rec.admits++
      rec.order.push('admit')
      // Fail-closed signal: the meter is broken (mirrors the real
      // `AiBudgetReserveError` thrown by admitAiReservation on a ledger-write
      // failure / invalid amount).
      if (opts.admitThrows) throw new Error('ledger write failed')
      if (opts.overCap) return { ok: false, reason: 'over-cap' }
      return { ok: true, reservation: FAKE_RESERVATION }
    },
    settleBudget: (reservation, actualUsd) => {
      rec.settled.push({ reservationId: reservation.id, actualUsd })
      rec.order.push('settle')
    },
    releaseBudget: (reservation) => {
      rec.released.push(reservation.id)
      rec.order.push('release')
    },
    estimateCost: (_model, usage) => {
      if ('estimatedCost' in opts) return opts.estimatedCost
      // Default: a positive, deterministic estimate whether or not usage exists,
      // so a paid generation always books a ledger cost in tests.
      return usage ? 0.0021 : 0.005
    },
    appendAudit: (entry) => { rec.audit.push(entry) },
    recordSpan: (attrs) => { rec.spans.push(attrs) },
    now: opts.now ?? (() => (clock += 10)),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { deps, rec }
}

function defaultResponse(): string {
  return JSON.stringify({
    oneLine: 'The team agreed to ship on Friday.',
    bullets: ['Alice proposed Friday', 'Bob agreed', 'CI is green', 'Docs pending', 'Release owner: Alice'],
  })
}

function msg(overrides: Partial<ThreadSummaryMessage> = {}): ThreadSummaryMessage {
  return {
    identityToken: `<id-${Math.random()}@example.com>`,
    from: 'alice@example.com',
    subject: 'Ship date',
    date: '2026-01-01',
    body: 'Body text here.',
    ...overrides,
  }
}

function baseOpts(overrides: Partial<ThreadSummaryOptions> = {}): ThreadSummaryOptions {
  return {
    accountId: '1',
    provider: 'openai-api',
    wasLocal: false,
    messages: [msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' }), msg({ identityToken: '<c@x>' })],
    ...overrides,
  }
}

beforeEach(() => {
  wrapSpy.mockClear()
})

// ── wrapUntrusted boundary — non-negotiable prompt-injection defense ──────────

describe('wrapUntrusted boundary', () => {
  testDb('wraps EVERY message body before it reaches the model', async () => {
    const { deps, rec } = makeHarness()
    const messages = [
      msg({ identityToken: '<a@x>', body: 'AAA' }),
      msg({ identityToken: '<b@x>', body: 'BBB' }),
      msg({ identityToken: '<c@x>', body: 'CCC' }),
      msg({ identityToken: '<d@x>', body: 'DDD' }),
    ]
    const res = await generateThreadSummary(deps, baseOpts({ messages }))
    expect(res.ok).toBe(true)
    // One wrap per message envelope (which embeds the body).
    expect(wrapSpy).toHaveBeenCalledTimes(4)
    // Each body appears INSIDE the boundary markers in the actual prompt.
    const prompt = rec.chatCalls[0].userPrompt
    for (const body of ['AAA', 'BBB', 'CCC', 'DDD']) {
      const startIdx = prompt.indexOf(DATA_BOUNDARY_START)
      expect(startIdx).toBeGreaterThanOrEqual(0)
      // The body must sit between a start marker and the matching end marker.
      const bodyIdx = prompt.indexOf(body)
      const startBefore = prompt.lastIndexOf(DATA_BOUNDARY_START, bodyIdx)
      const endAfter = prompt.indexOf(DATA_BOUNDARY_END, bodyIdx)
      expect(startBefore).toBeGreaterThanOrEqual(0)
      expect(endAfter).toBeGreaterThan(bodyIdx)
    }
  })

  testDb('records the wrapped-body count in the audit row (untrustedWrapped)', async () => {
    const { deps, rec } = makeHarness()
    const messages = [msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' }), msg({ identityToken: '<c@x>' })]
    await generateThreadSummary(deps, baseOpts({ messages }))
    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].untrustedWrapped).toBe(3)
  })

  testDb('buildSummaryUserPrompt reports the number of wrapped bodies', () => {
    const { prompt, wrappedCount } = buildSummaryUserPrompt([msg(), msg(), msg()])
    expect(wrappedCount).toBe(3)
    expect(prompt).toContain(DATA_BOUNDARY_START)
    expect(prompt).toContain(DATA_BOUNDARY_END)
  })
})

// ── Cache HIT — no provider call, no audit, no span ───────────────────────────

describe('cache hit', () => {
  testDb('returns cached WITHOUT provider call / audit row / telemetry span', async () => {
    const cached: ThreadSummaryRow = {
      threadHash: 'deadbeef',
      accountId: '1',
      oneLine: 'cached one liner',
      bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
      provider: 'openai-api',
      createdAt: 999,
    }
    const { deps, rec } = makeHarness({ cached })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({
      ok: true,
      summary: {
        threadHash: 'deadbeef',
        oneLine: 'cached one liner',
        bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
        provider: 'openai-api',
        cached: true,
        wasLocal: false,
        createdAt: 999,
      },
    })
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.audit).toHaveLength(0)
    expect(rec.spans).toHaveLength(0)
    expect(rec.upserts).toHaveLength(0)
    // wrapUntrusted must not run either — no body ever reached a prompt.
    expect(wrapSpy).not.toHaveBeenCalled()
  })

  testDb('queries the cache with the CALLER account id, not a hardcoded one', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ accountId: '7' }))
    expect(rec.cacheLookups[0].accountId).toBe('7')
  })
})

// ── Cross-account cache isolation (HIGH) ─────────────────────────────────────
//
// A summary cached for account A must NEVER be served to account B, even when
// the two accounts open a thread with the SAME identity set (same thread hash).
// The cache lookup is account-scoped, so account B misses and generates its own.

describe('cross-account cache isolation', () => {
  function cachedRow(accountId: string): ThreadSummaryRow {
    return {
      threadHash: 'shared-hash',
      accountId,
      oneLine: `summary for account ${accountId}`,
      bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
      provider: 'openai-api',
      createdAt: 1,
    }
  }

  testDb('account A gets its cached row; account B (same thread hash) MISSES and generates', async () => {
    const sharedMessages = [msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' }), msg({ identityToken: '<c@x>' })]
    // Only account "1" has a cached row for the shared hash.
    const { deps, rec } = makeHarness({ cachedByAccount: { '1': cachedRow('1') } })

    const a = await generateThreadSummary(deps, baseOpts({ accountId: '1', messages: sharedMessages }))
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.summary.oneLine).toBe('summary for account 1')
    // Cache HIT — no provider call for account 1.
    expect(rec.chatCalls).toHaveLength(0)

    const b = await generateThreadSummary(deps, baseOpts({ accountId: '2', messages: sharedMessages }))
    expect(b.ok).toBe(true)
    // Account 2 MISSED the cache (its lookup was scoped to accountId '2') and
    // generated fresh — it never received account 1's row.
    expect(rec.chatCalls).toHaveLength(1)
    if (b.ok) expect(b.summary.oneLine).not.toBe('summary for account 1')
    // Both lookups used the SAME recomputed hash but DIFFERENT account ids.
    expect(rec.cacheLookups.map((c) => c.accountId)).toEqual(['1', '2'])
    expect(rec.cacheLookups[0].threadHash).toBe(rec.cacheLookups[1].threadHash)
  })
})

// ── §2.51 atomic budget admission → structured refusal (never a throw) ───────
//
// The fourth paid surface (thread summary) runs the SAME admit/settle/release
// contract as the main chat, quick actions and instant reply: the reservation is
// taken BEFORE the model call, and BOTH denial modes (over-cap and a broken
// meter) refuse without ever reaching the provider.

describe('budget admission (§2.51)', () => {
  testDb('OVER-CAP: structured refusal { ok:false, reason:"budget" }, provider never called', async () => {
    const { deps, rec } = makeHarness({ overCap: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'budget' })
    expect(rec.admits).toBe(1)
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.audit).toHaveLength(0)
    expect(rec.spans).toHaveLength(0)
    // Nothing to settle or release — no reservation was ever booked.
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
  })

  testDb('FAIL-CLOSED: a THROWING meter DENIES the call (never proceeds unmetered)', async () => {
    // This is the hole §2.51 closes on this surface: the old code checked the
    // budget before and recorded the cost after, swallowing ledger failures — a
    // broken meter meant unlimited spend. A reservation failure must now refuse.
    const { deps, rec } = makeHarness({ admitThrows: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'budget' })
    expect(rec.admits).toBe(1)
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
  })

  testDb('a throwing meter does not leak the exception across the IPC boundary', async () => {
    const { deps } = makeHarness({ admitThrows: true })
    await expect(generateThreadSummary(deps, baseOpts())).resolves.toEqual({ ok: false, reason: 'budget' })
  })

  testDb('does not throw on an over-cap denial', async () => {
    const { deps } = makeHarness({ overCap: true })
    await expect(generateThreadSummary(deps, baseOpts())).resolves.toBeDefined()
  })

  testDb('RESERVES BEFORE the model call, then settles after it', async () => {
    // Ordering is the invariant, not just co-occurrence: a reservation taken
    // after the call would leave the same concurrent-bypass window open.
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    expect(rec.order).toEqual(['admit', 'chat', 'settle'])
  })
})

// ── Too-short / no-provider refusals ─────────────────────────────────────────

describe('refusals', () => {
  testDb(`refuses threads shorter than ${MIN_SUMMARY_MESSAGES} messages`, async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts({ messages: [msg(), msg()] }))
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    expect(rec.chatCalls).toHaveLength(0)
  })

  testDb('refuses when no provider is configured', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts({ provider: '' }))
    expect(res).toEqual({ ok: false, reason: 'no_provider' })
    expect(rec.chatCalls).toHaveLength(0)
  })

  testDb('refuses (too_short) when the identity set is empty', async () => {
    const { deps } = makeHarness()
    const messages = [msg({ identityToken: '  ' }), msg({ identityToken: '' }), msg({ identityToken: '   ' })]
    const res = await generateThreadSummary(deps, baseOpts({ messages }))
    expect(res).toEqual({ ok: false, reason: 'too_short' })
  })
})

// ── Success path — upsert, exactly-once audit + span, exactly 5 bullets ───────

describe('generation success', () => {
  testDb('generates, upserts, writes exactly ONE audit row and ONE span, returns 5 bullets', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.summary.bullets).toHaveLength(SUMMARY_BULLET_COUNT)
    expect(res.summary.cached).toBe(false)
    expect(rec.chatCalls).toHaveLength(1)
    expect(rec.upserts).toHaveLength(1)
    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].outcome).toBe('ok')
    expect(rec.audit[0].goal).toBe('summary')
    expect(rec.spans).toHaveLength(1)
    expect(rec.spans[0].errorClass).toBe('none')
    expect(rec.spans[0].tokensIn).toBe(100)
    expect(rec.spans[0].tokensOut).toBe(40)
  })

  testDb('reports wasLocal through to the telemetry span', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ wasLocal: true, provider: 'local' }))
    expect(rec.spans[0].wasLocal).toBe(true)
    expect(rec.spans[0].provider).toBe('local')
  })

  testDb('pads a short bullet list to exactly 5', async () => {
    const { deps } = makeHarness({
      respond: JSON.stringify({ oneLine: 'ok', bullets: ['only one'] }),
    })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.summary.bullets).toHaveLength(SUMMARY_BULLET_COUNT)
  })

  testDb('truncates a long bullet list to exactly 5', async () => {
    const { deps } = makeHarness({
      respond: JSON.stringify({ oneLine: 'ok', bullets: ['1', '2', '3', '4', '5', '6', '7'] }),
    })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.summary.bullets).toHaveLength(SUMMARY_BULLET_COUNT)
      expect(res.summary.bullets).toEqual(['1', '2', '3', '4', '5'])
    }
  })

  testDb('survives an upsert (cache-write) failure and still returns the summary', async () => {
    const { deps, rec } = makeHarness({ upsertThrows: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    // Audit + span still emitted (generation succeeded; only the cache write failed).
    expect(rec.audit).toHaveLength(1)
    expect(rec.spans).toHaveLength(1)
  })

  testDb('ALWAYS recomputes the thread hash from identity tokens (never trusts any caller value)', async () => {
    const { deps, rec } = makeHarness()
    const messages = [msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' }), msg({ identityToken: '<c@x>' })]
    await generateThreadSummary(deps, baseOpts({ messages }))
    const expected = computeThreadHash(messages.map((m) => m.identityToken))
    // The upsert AND the account-scoped cache lookup both key on the RECOMPUTED
    // hash — not on any value the caller could supply.
    expect(rec.upserts[0].threadHash).toBe(expected)
    expect(rec.cacheLookups[0].threadHash).toBe(expected)
  })

  testDb('is order-independent: same identity set in any order → same recomputed hash', async () => {
    const a = makeHarness()
    const b = makeHarness()
    const set1 = [msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' }), msg({ identityToken: '<c@x>' })]
    const set2 = [msg({ identityToken: '<c@x>' }), msg({ identityToken: '<a@x>' }), msg({ identityToken: '<b@x>' })]
    await generateThreadSummary(a.deps, baseOpts({ messages: set1 }))
    await generateThreadSummary(b.deps, baseOpts({ messages: set2 }))
    expect(a.rec.upserts[0].threadHash).toBe(b.rec.upserts[0].threadHash)
  })
})

// ── Provider pinning (HIGH) ──────────────────────────────────────────────────
//
// The completion MUST run on the provider the caller selected, not an
// independently re-read one — otherwise the provider telemetry/cache record as
// "used" diverges from the provider that actually ran.

describe('provider pinning', () => {
  testDb('runs the completion on the SELECTED provider (passed as the first chat arg)', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ provider: 'anthropic-api' }))
    expect(rec.chatCalls[0].provider).toBe('anthropic-api')
  })

  testDb('the provider recorded in the cache/audit/span matches the provider that ran', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ provider: 'gemini-api' }))
    expect(rec.chatCalls[0].provider).toBe('gemini-api')
    expect(rec.upserts[0].provider).toBe('gemini-api')
    expect(rec.audit[0].provider).toBe('gemini-api')
    expect(rec.spans[0].provider).toBe('gemini-api')
    // The ledger charge is attributed at ADMISSION time (main binds the selected
    // provider into `admitBudget`); the generator only settles that same handle.
    expect(rec.settled).toHaveLength(1)
    expect(rec.settled[0].reservationId).toBe(FAKE_RESERVATION.id)
  })
})

// ── Unusable provider selection (HIGH) ───────────────────────────────────────
//
// §2.218 — this block used to cover the `subscription` provider, which had no
// one-shot Messages-API contour and was refused explicitly so it would never be
// recorded as a FAILED API call. That provider is gone; the invariant it proved
// is not, and it now rests on the only refusal left: a selection that resolves
// to nothing must refuse BEFORE any provider call, reservation, audit row or
// span. A config state is not a provider error.

describe('unusable provider selection', () => {
  testDb('refuses an unusable selection with no_provider WITHOUT calling the provider or reserving budget', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts({ provider: '' }))
    expect(res).toEqual({ ok: false, reason: 'no_provider' })
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.admits).toBe(0)
    expect(rec.audit).toHaveLength(0)
    expect(rec.spans).toHaveLength(0)
  })
})

// ── Budget reservation ledger (HIGH) ─────────────────────────────────────────
//
// A successful paid generation MUST settle its reservation with the ACTUAL cost
// so the daily/monthly cap accounts for summary spend, and every path that spent
// nothing MUST release its hold so it does not linger and over-count the cap.

describe('budget reservation ledger (§2.51)', () => {
  testDb('settles EXACTLY ONCE per successful paid generation (no double-count)', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
    // The pre-parse settle is the ONLY settle; the success path must not settle
    // a second time (reconcile replaces in place — one net ledger charge).
    expect(rec.settled).toHaveLength(1)
    expect(rec.settled[0].actualUsd).toBeGreaterThan(0)
    expect(rec.settled[0].reservationId).toBe(FAKE_RESERVATION.id)
    expect(rec.released).toHaveLength(0)
    // Cache is written exactly once on success.
    expect(rec.upserts).toHaveLength(1)
  })

  testDb('settles a conservative amount even when the provider reports NO usage', async () => {
    // usage null → estimateCost still returns a positive conservative amount.
    const { deps, rec } = makeHarness({ usage: null })
    await generateThreadSummary(deps, baseOpts())
    expect(rec.settled).toHaveLength(1)
    expect(rec.settled[0].actualUsd).toBeGreaterThan(0)
  })

  testDb('a cache HIT never reserves, settles or releases', async () => {
    const cached: ThreadSummaryRow = {
      threadHash: 'x', accountId: '1', oneLine: 'c', bullets: ['1', '2', '3', '4', '5'],
      provider: 'openai-api', createdAt: 1,
    }
    const { deps, rec } = makeHarness({ cached })
    await generateThreadSummary(deps, baseOpts())
    expect(rec.admits).toBe(0)
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
  })

  testDb('a PROVABLY unbilled outcome RELEASES the hold — no spend', async () => {
    // An `unbilled` verdict means NO tokens were spent (no key / unsupported
    // provider / non-2xx / pre-dispatch failure) — the hold must be freed.
    const { deps, rec } = makeHarness({ respond: null })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toEqual([FAKE_RESERVATION.id])
    expect(rec.order).toEqual(['admit', 'chat', 'release'])
  })

  testDb('a chat-dep THROW HOLDS the floor — no evidence either way (§2.51.f2)', async () => {
    // The chat dep classifies internally and is not expected to throw. If it
    // does, we cannot prove the call was free, so the conservative reservation
    // stands: an over-count is bounded, an under-count is uncapped spend.
    const { deps, rec } = makeHarness({ chatThrows: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
    expect(rec.order).toEqual(['admit', 'chat'])
  })

  testDb('a no-provider refusal never reserves — no call was made', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts({ provider: '' }))
    expect(res).toEqual({ ok: false, reason: 'no_provider' })
    expect(rec.admits).toBe(0)
    expect(rec.chatCalls).toHaveLength(0)
  })

  testDb('a too_short refusal never reserves — no call was made', async () => {
    const { deps, rec } = makeHarness()
    const res = await generateThreadSummary(deps, baseOpts({ messages: [msg(), msg()] }))
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    expect(rec.admits).toBe(0)
    expect(rec.chatCalls).toHaveLength(0)
  })

  testDb('an over-cap denial never calls the provider and books nothing', async () => {
    const { deps, rec } = makeHarness({ overCap: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'budget' })
    expect(rec.settled).toHaveLength(0)
    expect(rec.chatCalls).toHaveLength(0)
  })

  // §2.51 fix-3 (HIGH-3), refined in §2.51.f2 — the release path is only
  // legitimate when the call was PROVABLY not billed, which is exactly the
  // `unbilled` verdict of the chat dep's outcome contract. A `billed` verdict
  // (any 2xx, including one whose body carries no usable text) is charged and
  // must settle; an `ambiguous` one keeps the floor. These tests pin all three
  // halves at this seam so a future change cannot silently reintroduce
  // "release a paid call".
  testDb('SETTLES a billed-but-empty completion (2xx with no usable text) — never releases', async () => {
    // The chat dep resolves to a `billed` outcome with empty text — the shape
    // aiChatSimpleOutcome returns for a charged-but-unusable 2xx.
    const { deps, rec } = makeHarness({ respond: '' })
    const res = await generateThreadSummary(deps, baseOpts())

    // Still a user-visible failure (nothing parseable) …
    expect(res.ok).toBe(false)
    // … but the paid call WAS booked against the cap, and never released.
    expect(rec.settled).toHaveLength(1)
    expect(rec.released).toHaveLength(0)
  })

  testDb('RELEASES only on a provably unbilled outcome', async () => {
    const { deps, rec } = makeHarness({ respond: null })
    const res = await generateThreadSummary(deps, baseOpts())

    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.released).toHaveLength(1)
    expect(rec.settled).toHaveLength(0)
  })

  // §2.51.f2 — the ambiguous half. Releasing here would make "drop the
  // connection after the request left the process" an unmetered call: the
  // provider may have accepted, generated and billed it with only the response
  // lost. The conservative floor therefore STANDS as the charge.
  testDb('HOLDS the reservation floor on an AMBIGUOUS post-dispatch transport failure', async () => {
    const { deps, rec } = makeHarness({ chatAmbiguous: true })
    const res = await generateThreadSummary(deps, baseOpts())

    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    // Neither settled nor released — the admitted reservation is the charge.
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
    expect(rec.order).toEqual(['admit', 'chat'])
  })

  testDb('the ambiguous refusal still books exactly one error audit row + span, and no cache write', async () => {
    const { deps, rec } = makeHarness({ chatAmbiguous: true })
    await generateThreadSummary(deps, baseOpts())

    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].outcome).toBe('error')
    expect(rec.spans).toHaveLength(1)
    expect(rec.spans[0].errorClass).toBe('provider_error')
    expect(rec.upserts).toHaveLength(0)
  })

  testDb('a settle failure never fails the generation (best-effort, hold stands)', async () => {
    const { deps } = makeHarness()
    deps.settleBudget = () => { throw new Error('ledger down') }
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
  })

  testDb('a release failure never fails the refusal (best-effort, hold stands)', async () => {
    const { deps } = makeHarness({ respond: null })
    deps.releaseBudget = () => { throw new Error('ledger down') }
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
  })

  testDb('does NOT settle when the completion is unpriceable — the hold stays as the charge', async () => {
    // Settling to 0 here would ERASE a real paid call from the cap. Leaving the
    // conservative reservation in place is the safe-side choice.
    const { deps, rec } = makeHarness({ estimatedCost: undefined })
    await generateThreadSummary(deps, baseOpts())
    expect(rec.settled).toHaveLength(0)
    expect(rec.released).toHaveLength(0)
  })

  // §2.51.f2 iteration 6 (High-2) — `undefined` and `0` are now DIFFERENT answers
  // from `estimateCost`. `undefined` still means "we cannot price this" and keeps
  // the conservative hold; an explicit `0` means "provably free", which is how
  // main.ts expresses a SELF-HOSTED endpoint (no provider, no bill). Without the
  // distinction the summary path was the last surface still charging a floor for
  // local inference while every other surface settled it at zero.
  testDb('SETTLES 0 when the cost estimator reports the call was provably free', async () => {
    const { deps, rec } = makeHarness({ estimatedCost: 0 })
    const res = await generateThreadSummary(deps, baseOpts())

    expect(res.ok).toBe(true)
    expect(rec.settled).toEqual([{ reservationId: FAKE_RESERVATION.id, actualUsd: 0 }])
    // Settled, not released — the accounting path is the same, only the amount
    // is zero, so the audit/telemetry story is unchanged.
    expect(rec.released).toHaveLength(0)
  })

  testDb('still settles a real measured cost for a local server that DOES report usage', async () => {
    const { deps, rec } = makeHarness({ estimatedCost: 0.0021 })
    await generateThreadSummary(deps, baseOpts())
    expect(rec.settled).toEqual([{ reservationId: FAKE_RESERVATION.id, actualUsd: 0.0021 }])
  })

  // §2.51.f2 iteration 8 — the fourth one-shot surface. A refused/unresolvable
  // endpoint reaches the generator as `unbilled/unreachable` (classified in
  // `aiChatSimpleOutcome`), and must release exactly like any other provably
  // unbilled outcome — holding a floor for an unreachable server invents money.
  describe('a pre-connect failure', () => {
    testDb('RELEASES the hold', async () => {
      const { deps, rec } = makeHarness()
      deps.chat = async () => ({ kind: 'unbilled', reason: 'unreachable' })

      const res = await generateThreadSummary(deps, baseOpts())

      expect(res).toEqual({ ok: false, reason: 'provider_error' })
      expect(rec.released).toEqual([FAKE_RESERVATION.id])
      expect(rec.settled).toHaveLength(0)
    })

    testDb('a post-connect transport failure still HOLDS the floor (contrast)', async () => {
      const { deps, rec } = makeHarness({ chatAmbiguous: true })

      await generateThreadSummary(deps, baseOpts())

      expect(rec.released).toHaveLength(0)
      expect(rec.settled).toHaveLength(0)
    })
  })

  // §2.51.f2 iteration 7 (High-2) — the AMBIGUOUS branch held the floor
  // unconditionally, so a self-hosted summary that failed with a 502/503 or a
  // dropped connection kept charging invented money. Every other paid surface
  // already released there; this was the last one out of step.
  describe('an ambiguous failure against a self-hosted endpoint', () => {
    testDb('RELEASES the hold instead of keeping a conservative floor', async () => {
      const { deps, rec } = makeHarness({ chatAmbiguous: true, allowFabrication: false })
      const res = await generateThreadSummary(deps, baseOpts())

      expect(res).toEqual({ ok: false, reason: 'provider_error' })
      expect(rec.released).toEqual([FAKE_RESERVATION.id])
      expect(rec.settled).toHaveLength(0)
    })

    testDb('still books exactly one error audit row + span, and no cache write', async () => {
      const { deps, rec } = makeHarness({ chatAmbiguous: true, allowFabrication: false })
      await generateThreadSummary(deps, baseOpts())

      expect(rec.audit).toHaveLength(1)
      expect(rec.audit[0].outcome).toBe('error')
      expect(rec.spans).toHaveLength(1)
      expect(rec.spans[0].errorClass).toBe('provider_error')
      expect(rec.upserts).toHaveLength(0)
    })

    testDb('a PAID endpoint still HOLDS the floor on the same failure (contrast)', async () => {
      const { deps, rec } = makeHarness({ chatAmbiguous: true, allowFabrication: true })
      const res = await generateThreadSummary(deps, baseOpts())

      expect(res).toEqual({ ok: false, reason: 'provider_error' })
      expect(rec.released).toHaveLength(0)
      expect(rec.settled).toHaveLength(0)
    })
  })

  // §2.51.f2 iteration 7 (High-3) — admission, execution and settlement must all
  // describe the SAME endpoint. They used to read settings independently (admit,
  // then the provider helper with no pinned snapshot, then the estimator calling
  // getSettings() again AFTER the answer), so flipping the base URL mid-request
  // could settle a PAID call at 0 — or fabricate a floor for a local one.
  describe('the endpoint verdict is frozen for the whole generation', () => {
    // Split of responsibility, stated so this suite does not claim more than it
    // can prove: the generator's half is "never derive the verdict yourself —
    // consult the injected value and price ONCE from the injected estimator".
    // Freezing the value against a mid-request `getSettings()` change is main.ts's
    // half (`buildThreadSummaryDeps` captures one snapshot before admission); a
    // dep-injected generator cannot enforce that for its caller.
    testDb('prices the completion exactly once and settles that amount verbatim', async () => {
      const seen: Array<string> = []
      const { deps, rec } = makeHarness({ estimatedCost: 0.0021 })
      const originalEstimate = deps.estimateCost
      deps.estimateCost = (model, usage) => {
        seen.push(model)
        return originalEstimate(model, usage)
      }

      await generateThreadSummary(deps, baseOpts())

      // One pricing call, no second opinion taken after the fact.
      expect(seen).toHaveLength(1)
      expect(rec.settled).toEqual([{ reservationId: FAKE_RESERVATION.id, actualUsd: 0.0021 }])
    })

    testDb('the ambiguous branch reads the frozen verdict too', async () => {
      let endpointNowRemote = false
      const { deps, rec } = makeHarness({ chatAmbiguous: true, allowFabrication: false })
      const originalChat = deps.chat
      deps.chat = async (provider, systemPrompt, userPrompt) => {
        endpointNowRemote = true
        return originalChat(provider, systemPrompt, userPrompt)
      }

      await generateThreadSummary(deps, baseOpts())

      expect(endpointNowRemote).toBe(true)
      // Still released — the flip after dispatch does not turn this into a hold.
      expect(rec.released).toEqual([FAKE_RESERVATION.id])
    })
  })
})

// ── Headers-only / empty-body refusal (HIGH) ─────────────────────────────────
//
// A partial/offline cache can yield messages whose body is not loaded. Empty
// bodies must be dropped, and a thread without ≥3 messages of REAL content must
// refuse too_short — never generate and PERMANENTLY CACHE a summary from nothing.

describe('headers-only / empty-body refusal', () => {
  testDb('drops empty-body messages and refuses too_short when < 3 have real content', async () => {
    const { deps, rec } = makeHarness()
    const messages = [
      msg({ identityToken: '<a@x>', body: 'real content one' }),
      msg({ identityToken: '<b@x>', body: '   ' }), // whitespace-only
      msg({ identityToken: '<c@x>', body: '' }),    // empty
      msg({ identityToken: '<d@x>', body: '\n\t ' }), // whitespace-only
    ]
    const res = await generateThreadSummary(deps, baseOpts({ messages }))
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    // Never reached a provider and never cached anything from empty content.
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.upserts).toHaveLength(0)
  })

  testDb('generates from the non-empty subset when ≥3 messages have real content', async () => {
    const { deps, rec } = makeHarness()
    const messages = [
      msg({ identityToken: '<a@x>', body: 'AAA' }),
      msg({ identityToken: '<b@x>', body: '   ' }), // dropped
      msg({ identityToken: '<c@x>', body: 'CCC' }),
      msg({ identityToken: '<d@x>', body: 'DDD' }),
    ]
    const res = await generateThreadSummary(deps, baseOpts({ messages }))
    expect(res.ok).toBe(true)
    // Only the 3 non-empty bodies were wrapped/prompted.
    expect(wrapSpy).toHaveBeenCalledTimes(3)
    expect(rec.upserts).toHaveLength(1)
  })
})

// ── PII-safety — audit row NEVER carries body/subject/address fields ─────────
//
// The audit log is a long-lived, exportable table (Settings → AI → Privacy
// Panel). AiActionLogEntry is structurally typed to only ever contain
// provider/model/goal/toolName/token counts/cost/outcome — but a regression
// that widens the entry shape or leaks message content into an existing
// string field (e.g. `goal`) would not be caught by a type check alone.
// These tests drive the generator with REALISTIC PII in every message field
// (subject, from, body) and assert none of it appears anywhere in the
// appended audit entry — field-by-field AND as a full-object substring scan.

describe('PII-safety — audit row contains no message content', () => {
  const PII_MARKERS = [
    'super-secret-project-codename',
    'alice.confidential@example.com',
    'Please wire $50,000 to account 12345',
    'SSN 123-45-6789',
  ]

  function piiMessages(): ThreadSummaryMessage[] {
    return [
      msg({ identityToken: '<a@x>', from: PII_MARKERS[1], subject: PII_MARKERS[0], body: PII_MARKERS[2] }),
      msg({ identityToken: '<b@x>', from: 'bob@example.com', subject: 'Re: budget', body: PII_MARKERS[3] }),
      msg({ identityToken: '<c@x>', from: 'carol@example.com', subject: 'Re: budget', body: 'Sounds good.' }),
    ]
  }

  testDb('the audit entry ONLY contains the documented aggregate keys — no body/subject/address field exists', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ messages: piiMessages() }))
    expect(rec.audit).toHaveLength(1)
    const keys = Object.keys(rec.audit[0]).sort()
    expect(keys).toEqual(
      ['costUsd', 'goal', 'injectionBlocked', 'inputTokens', 'model', 'outcome', 'outputTokens', 'provider', 'toolName', 'untrustedWrapped'].sort(),
    )
  })

  testDb('no PII marker from subject/from/body appears anywhere in the serialized audit entry', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ messages: piiMessages() }))
    const serialized = JSON.stringify(rec.audit[0])
    for (const marker of PII_MARKERS) {
      expect(serialized).not.toContain(marker)
    }
  })

  testDb('the error-outcome audit row (provider_error path) is also PII-safe', async () => {
    const { deps, rec } = makeHarness({ respond: null })
    await generateThreadSummary(deps, baseOpts({ messages: piiMessages() }))
    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].outcome).toBe('error')
    const serialized = JSON.stringify(rec.audit[0])
    for (const marker of PII_MARKERS) {
      expect(serialized).not.toContain(marker)
    }
  })

  testDb('the persisted cache row (oneLine/bullets) is model output, not raw message content — never equals a PII marker verbatim', async () => {
    const { deps, rec } = makeHarness()
    await generateThreadSummary(deps, baseOpts({ messages: piiMessages() }))
    expect(rec.upserts).toHaveLength(1)
    const persistedText = JSON.stringify(rec.upserts[0])
    for (const marker of PII_MARKERS) {
      expect(persistedText).not.toContain(marker)
    }
  })
})

// ── Provider / parse errors → structured refusal + error audit + error span ──

describe('provider and parse errors', () => {
  testDb('unbilled provider outcome → { ok:false, reason:"provider_error" } with error audit + span', async () => {
    const { deps, rec } = makeHarness({ respond: null })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.upserts).toHaveLength(0)
    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].outcome).toBe('error')
    expect(rec.spans).toHaveLength(1)
    expect(rec.spans[0].errorClass).toBe('provider_error')
  })

  testDb('chat dep throws → structured refusal (never rethrows)', async () => {
    const { deps, rec } = makeHarness({ chatThrows: true })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.audit[0].outcome).toBe('error')
    expect(rec.spans[0].errorClass).toBe('provider_error')
  })

  testDb('unparseable model output → provider_error, no upsert', async () => {
    const { deps, rec } = makeHarness({ respond: 'not json at all' })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    expect(rec.upserts).toHaveLength(0)
    expect(rec.audit[0].outcome).toBe('error')
  })

  testDb('parse failure records the parse_error telemetry class (distinct from provider_error)', async () => {
    const { deps, rec } = makeHarness({ respond: 'not json at all' })
    await generateThreadSummary(deps, baseOpts())
    expect(rec.spans).toHaveLength(1)
    // The declared `parse_error` taxonomy must actually fire on a parse failure —
    // it previously mislabelled parse failures as `provider_error`.
    expect(rec.spans[0].errorClass).toBe('parse_error')
  })

  testDb('a parse failure SETTLES exactly one reservation (the completion was paid) but does NOT write the cache', async () => {
    // A non-null completion with malformed JSON is ALREADY billable — the API
    // call was made and tokens were spent. The reservation must be settled with
    // the real cost exactly once (before parsing) so repeated junk responses
    // still advance the budget cap, while the parse failure still refuses
    // provider_error and never caches. It must NOT be released as "no spend".
    const { deps, rec } = makeHarness({ respond: 'not json at all', usage: { inputTokens: 100, outputTokens: 40 } })
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res).toEqual({ ok: false, reason: 'provider_error' })
    // EXACTLY ONE settle — not zero (was the bug), not two, and never a release.
    expect(rec.settled).toHaveLength(1)
    expect(rec.settled[0].actualUsd).toBeGreaterThan(0)
    expect(rec.released).toHaveLength(0)
    // Cache is NOT written on a parse failure.
    expect(rec.upserts).toHaveLength(0)
    // The parse-error telemetry class is still recorded (fix #6 not regressed).
    expect(rec.spans).toHaveLength(1)
    expect(rec.spans[0].errorClass).toBe('parse_error')
    expect(rec.audit).toHaveLength(1)
    expect(rec.audit[0].outcome).toBe('error')
  })

  testDb('telemetry sink throwing never fails the generation', async () => {
    const { deps } = makeHarness()
    deps.recordSpan = () => { throw new Error('sink down') }
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
  })

  testDb('audit sink throwing never fails the generation', async () => {
    const { deps } = makeHarness()
    deps.appendAudit = () => { throw new Error('audit down') }
    const res = await generateThreadSummary(deps, baseOpts())
    expect(res.ok).toBe(true)
  })
})

// ── Pure parser / normalizer units ───────────────────────────────────────────

describe('parseSummaryResponse', () => {
  testDb('parses a plain JSON object', () => {
    const out = parseSummaryResponse(JSON.stringify({ oneLine: 'x', bullets: ['a', 'b'] }))
    expect(out?.oneLine).toBe('x')
    expect(out?.bullets).toHaveLength(SUMMARY_BULLET_COUNT)
  })

  testDb('parses JSON wrapped in a ```json fence', () => {
    const out = parseSummaryResponse('```json\n{"oneLine":"x","bullets":["a"]}\n```')
    expect(out?.oneLine).toBe('x')
  })

  testDb('parses JSON with trailing prose', () => {
    const out = parseSummaryResponse('{"oneLine":"x","bullets":["a"]}\nHope this helps!')
    expect(out?.oneLine).toBe('x')
  })

  testDb('rejects empty / missing oneLine', () => {
    expect(parseSummaryResponse(JSON.stringify({ oneLine: '', bullets: ['a'] }))).toBeNull()
    expect(parseSummaryResponse(JSON.stringify({ bullets: ['a'] }))).toBeNull()
  })

  testDb('rejects non-JSON', () => {
    expect(parseSummaryResponse('hello world')).toBeNull()
    expect(parseSummaryResponse('')).toBeNull()
  })
})

describe('normalizeBullets', () => {
  testDb('always returns exactly 5', () => {
    expect(normalizeBullets([])).toHaveLength(5)
    expect(normalizeBullets(['a'])).toHaveLength(5)
    expect(normalizeBullets(['a', 'b', 'c', 'd', 'e'])).toHaveLength(5)
    expect(normalizeBullets(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(5)
  })
})
