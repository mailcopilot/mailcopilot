import { describe, expect, it, vi, beforeEach } from 'vitest'
import { z } from 'zod'

/**
 * §3.3 B2 Thread AI Summary — `ai:threadSummary:generate` IPC handler tests
 * (mirror pattern, same technique as `main.auditLogClear.test.ts` and
 * `main.externalGate.test.ts`).
 *
 * `electron/main.ts` cannot be imported directly in unit tests (module-level
 * side effects: BrowserWindow creation, IPC registration, DB open, IDLE cycle,
 * etc.), so this file mirrors the handler logic verbatim with injectable deps.
 * Keep in sync with the production handler in `electron/main.ts` §"IPC: §3.3
 * B2 Thread AI Summary".
 *
 * Coverage this file adds (gap analysis against the independent test-gen
 * brief, cross-checked against the already-shipped
 * `electron/services/aiThreadSummary.test.ts` which owns the GENERATOR
 * contract — cache-hit no-side-effects, wrapUntrusted boundary, budget
 * refusal, exactly-5-bullets, audit/telemetry never breaking generation):
 *
 *   - AC9  Per-account opt-in gate: OFF → { ok:false, reason:'opt_out' }
 *          WITHOUT calling the generator at all (main-side short-circuit,
 *          not the generator's own gate — the generator has no opt-in
 *          concept, only main does).
 *   - AC11 IPC input validation via the zod schema: missing accountId,
 *          >50 message refs, non-array messages, and other malformed shapes
 *          are rejected (thrown ZodError) before any DB/generator call.
 *   - Message-ref → ThreadSummaryMessage mapping: renderer supplies ONLY
 *          (folder, uid) refs; main fetches canonical bodies AND the identity
 *          token from the local DB and never trusts renderer-supplied body text
 *          OR a renderer-supplied messageId/hash. Missing rows (getMessageByUid
 *          returns undefined) and empty-body rows are skipped, not thrown.
 *   - Security regression guards (this fix wave): a renderer-supplied
 *          `messageId`/`threadHash` is stripped by the schema and can NOT
 *          influence the identity token; empty-body rows are dropped so a
 *          headers-only thread cannot be summarized/cached.
 */

// ---------------------------------------------------------------------------
// Mirror: zod schemas (verbatim copy of electron/main.ts §3.3 B2 section)
// ---------------------------------------------------------------------------

const accountIdSchema = z.number().int().positive()
const AI_SUMMARY_MAX_MESSAGES = 50
const MIN_SUMMARY_MESSAGES = 3

// Only (folder, uid) — no messageId. zod strips unknown keys, so a renderer
// still sending messageId has it dropped here and it never reaches main.
const threadSummaryMessageRefSchema = z.object({
  folder: z.string().min(1).max(1024),
  uid: z.number().int().positive(),
})

// No threadHash — main ALWAYS recomputes the identity hash from DB-sourced
// identity tokens; a renderer-supplied hash would be a cross-thread read vector.
const threadSummaryGenerateSchema = z.object({
  accountId: accountIdSchema,
  messages: z.array(threadSummaryMessageRefSchema).min(1).max(AI_SUMMARY_MAX_MESSAGES),
})

// ---------------------------------------------------------------------------
// Mirror: handler logic with injectable deps
// ---------------------------------------------------------------------------

interface MessageRow {
  from: string | null
  subject: string | null
  date: string | null
  bodyText: string | null
  messageId: string | null
}

interface ThreadSummaryMessage {
  identityToken: string
  from: string
  subject: string
  date: string
  body: string
}

type ThreadSummaryOutcome =
  | { ok: true; summary: { threadHash: string; oneLine: string; bullets: string[]; provider: string; cached: boolean; wasLocal: boolean; createdAt: number } }
  | { ok: false; reason: string }

interface HandlerDeps {
  isThreadSummaryEnabledForAccount: (accountId: number) => boolean
  getMessageByUid: (accountId: number, folder: string, uid: number) => MessageRow | undefined
  selectSummaryProvider: () => { provider: string | null; wasLocal: boolean }
  generateThreadSummary: (opts: {
    accountId: string
    provider: string
    wasLocal: boolean
    messages: ThreadSummaryMessage[]
  }) => Promise<ThreadSummaryOutcome>
}

/** Mirrors the `runThreadSummaryGenerate` handler BODY in electron/main.ts
 *  (the inner function the per-account single-flight wraps). */
async function mirrorGenerateHandler(
  payload: unknown,
  deps: HandlerDeps,
): Promise<ThreadSummaryOutcome> {
  const req = threadSummaryGenerateSchema.parse(payload)

  if (!deps.isThreadSummaryEnabledForAccount(req.accountId)) {
    return { ok: false, reason: 'opt_out' }
  }

  const acctId = String(req.accountId)

  const cap = req.messages.slice(-AI_SUMMARY_MAX_MESSAGES)
  const messages: ThreadSummaryMessage[] = []
  // Dedupe by RESOLVED identity so only DISTINCT messages count toward the MIN
  // gate — a repeated (folder, uid) ref resolves the same row/identity and must
  // count once (mirrors electron/main.ts).
  const seenIdentities = new Set<string>()
  for (const ref of cap) {
    const row = deps.getMessageByUid(req.accountId, ref.folder, ref.uid)
    if (!row) continue
    // Skip empty-body (headers-only / partial-cache) rows — never summarize or
    // cache from no content.
    const body = typeof row.bodyText === 'string' ? row.bodyText : ''
    if (body.trim().length === 0) continue
    // Identity token comes ONLY from the DB row's Message-ID or a synthetic
    // account:folder:uid fallback — never from a renderer-supplied value.
    const identityToken =
      (typeof row.messageId === 'string' && row.messageId.trim().length > 0)
        ? row.messageId.trim()
        : `${req.accountId}:${ref.folder}:${ref.uid}`
    // Distinct-message gate: a repeated identity is counted once (same set
    // computeThreadHash keys on).
    if (seenIdentities.has(identityToken)) continue
    seenIdentities.add(identityToken)
    messages.push({
      identityToken,
      from: row.from ?? '',
      subject: row.subject ?? '',
      date: row.date ?? '',
      body,
    })
  }

  if (messages.length < MIN_SUMMARY_MESSAGES) {
    return { ok: false, reason: 'too_short' }
  }

  const { provider, wasLocal } = deps.selectSummaryProvider()

  return deps.generateThreadSummary({
    accountId: acctId,
    provider: provider ?? '',
    wasLocal,
    messages,
  })
}

// ---------------------------------------------------------------------------
// Mirror: per-account single-flight wrapper (electron/main.ts; latency /
// duplicate-work containment since §2.51 made the cap atomic). Verbatim
// structure of the production wrapper — a
// module-level Map<accountId, Promise> chaining each request after the previous
// in-flight one for the SAME account, tail-only cleanup, predecessor-error
// swallowed so one failure never poisons the chain for the next. Each factory
// call gets its OWN map so tests do not share single-flight state.
// ---------------------------------------------------------------------------

function makeSerializedHandler(deps: HandlerDeps) {
  const inFlight = new Map<number, Promise<unknown>>()
  return function serializedGenerate(payload: {
    accountId: number
    messages: unknown
  }): Promise<ThreadSummaryOutcome> {
    // Schema is validated inside mirrorGenerateHandler; the wrapper only needs
    // the accountId to key the single-flight (matches production, which reads
    // `req.accountId` after parse — but the parse is inside the chained body).
    const accountId = payload.accountId
    const predecessor = inFlight.get(accountId)
    const gated: Promise<ThreadSummaryOutcome> =
      (predecessor ? predecessor.catch(() => undefined) : Promise.resolve())
        .then(() => mirrorGenerateHandler(payload, deps))

    inFlight.set(accountId, gated)
    gated
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.get(accountId) === gated) {
          inFlight.delete(accountId)
        }
      })
      .catch(() => { /* swallow — result/rejection propagates via `gated` */ })

    return gated
  }
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    from: 'alice@example.com',
    subject: 'Ship date',
    date: '2026-01-01',
    bodyText: 'Body text here.',
    messageId: null,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    isThreadSummaryEnabledForAccount: vi.fn(() => true),
    getMessageByUid: vi.fn(() => makeRow()),
    selectSummaryProvider: vi.fn(() => ({ provider: 'anthropic-api', wasLocal: false })),
    generateThreadSummary: vi.fn(async () => ({
      ok: true as const,
      summary: {
        threadHash: 'h1', oneLine: 'ol', bullets: ['a', 'b', 'c', 'd', 'e'],
        provider: 'anthropic-api', cached: false, wasLocal: false, createdAt: 1,
      },
    })),
    ...overrides,
  }
}

/**
 * Build message refs. Includes a renderer-supplied `messageId` on purpose — the
 * schema STRIPS it, so these tests double as a guard that a renderer messageId
 * cannot leak into the handler.
 */
function refs(n: number): Array<{ folder: string; uid: number; messageId?: string | null }> {
  return Array.from({ length: n }, (_, i) => ({ folder: 'INBOX', uid: i + 1, messageId: `<m${i + 1}@x>` }))
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return { accountId: 1, messages: refs(3), ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC9 — per-account opt-in gate
// ---------------------------------------------------------------------------

describe('ai:threadSummary:generate — per-account opt-in gate (AC9)', () => {
  it('refuses with reason:"opt_out" when the account toggle is OFF', async () => {
    const deps = makeDeps({ isThreadSummaryEnabledForAccount: vi.fn(() => false) })
    const res = await mirrorGenerateHandler(basePayload(), deps)
    expect(res).toEqual({ ok: false, reason: 'opt_out' })
  })

  it('does NOT call getMessageByUid when opted out (no DB read for a refused account)', async () => {
    const deps = makeDeps({ isThreadSummaryEnabledForAccount: vi.fn(() => false) })
    await mirrorGenerateHandler(basePayload(), deps)
    expect(deps.getMessageByUid).not.toHaveBeenCalled()
  })

  it('does NOT call generateThreadSummary when opted out (no provider spend, no audit, no telemetry)', async () => {
    const deps = makeDeps({ isThreadSummaryEnabledForAccount: vi.fn(() => false) })
    await mirrorGenerateHandler(basePayload(), deps)
    expect(deps.generateThreadSummary).not.toHaveBeenCalled()
  })

  it('checks the opt-in gate for the account in the PAYLOAD, not a stale/global value', async () => {
    const deps = makeDeps({
      isThreadSummaryEnabledForAccount: vi.fn((accountId: number) => accountId === 2),
    })
    const refused = await mirrorGenerateHandler(basePayload({ accountId: 1 }), deps)
    expect(refused).toEqual({ ok: false, reason: 'opt_out' })

    const allowed = await mirrorGenerateHandler(basePayload({ accountId: 2 }), deps)
    expect(allowed.ok).toBe(true)
    expect(deps.isThreadSummaryEnabledForAccount).toHaveBeenCalledWith(2)
  })

  it('proceeds to generate when opted in', async () => {
    const deps = makeDeps()
    const res = await mirrorGenerateHandler(basePayload(), deps)
    expect(res.ok).toBe(true)
    expect(deps.generateThreadSummary).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC11 — IPC input validation (zod schemas reject malformed payloads)
// ---------------------------------------------------------------------------

describe('ai:threadSummary:generate — IPC input validation (AC11)', () => {
  it('rejects a payload missing accountId', async () => {
    const deps = makeDeps()
    await expect(mirrorGenerateHandler({ messages: refs(3) }, deps)).rejects.toThrow()
    expect(deps.isThreadSummaryEnabledForAccount).not.toHaveBeenCalled()
  })

  it('rejects accountId 0 / negative / non-integer (accountIdSchema: positive int)', async () => {
    const deps = makeDeps()
    for (const bad of [0, -1, 1.5, '1', null]) {
      await expect(mirrorGenerateHandler(basePayload({ accountId: bad }), deps)).rejects.toThrow()
    }
  })

  it('rejects more than 50 message refs (AI_SUMMARY_MAX_MESSAGES)', async () => {
    const deps = makeDeps()
    await expect(
      mirrorGenerateHandler(basePayload({ messages: refs(51) }), deps),
    ).rejects.toThrow()
  })

  it('accepts exactly 50 message refs (boundary)', async () => {
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow()) })
    const res = await mirrorGenerateHandler(basePayload({ messages: refs(50) }), deps)
    expect(res.ok).toBe(true)
  })

  it('rejects a non-array messages field', async () => {
    const deps = makeDeps()
    for (const bad of [null, undefined, 'not-an-array', {}, 42]) {
      await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
    }
  })

  it('rejects an empty messages array (schema requires min(1), even though MIN_SUMMARY_MESSAGES is 3)', async () => {
    const deps = makeDeps()
    await expect(mirrorGenerateHandler(basePayload({ messages: [] }), deps)).rejects.toThrow()
  })

  it('rejects a message ref missing folder', async () => {
    const deps = makeDeps()
    const bad = [{ uid: 1, messageId: '<a@x>' }, { folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 }]
    await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
  })

  it('rejects a message ref with a non-positive uid', async () => {
    const deps = makeDeps()
    const bad = [{ folder: 'INBOX', uid: 0 }, { folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 }]
    await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
  })

  it('rejects a message ref with a non-integer uid', async () => {
    const deps = makeDeps()
    const bad = [{ folder: 'INBOX', uid: 1.5 }, { folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 }]
    await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
  })

  it('rejects a folder string longer than 1024 chars', async () => {
    const deps = makeDeps()
    const bad = [{ folder: 'x'.repeat(1025), uid: 1 }, { folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 }]
    await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
  })

  it('rejects an empty folder string', async () => {
    const deps = makeDeps()
    const bad = [{ folder: '', uid: 1 }, { folder: 'INBOX', uid: 2 }, { folder: 'INBOX', uid: 3 }]
    await expect(mirrorGenerateHandler(basePayload({ messages: bad }), deps)).rejects.toThrow()
  })

  it('accepts refs that carry a renderer messageId — the schema strips it (no throw)', async () => {
    const deps = makeDeps()
    const okMsgs = [
      { folder: 'INBOX', uid: 1, messageId: '<caller@x>' },
      { folder: 'INBOX', uid: 2, messageId: null },
      { folder: 'INBOX', uid: 3, messageId: undefined },
    ]
    const res = await mirrorGenerateHandler(basePayload({ messages: okMsgs }), deps)
    expect(res.ok).toBe(true)
  })

  it('strips a renderer-supplied threadHash (extra key) rather than using it', async () => {
    const deps = makeDeps()
    // A forged threadHash is not in the schema — zod strips it, so the handler
    // proceeds normally and the generator recomputes its own hash. No throw, and
    // the forged value never reaches the generator opts.
    const res = await mirrorGenerateHandler(basePayload({ threadHash: 'x'.repeat(200) }), deps)
    expect(res.ok).toBe(true)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect('threadHash' in call).toBe(false)
  })

  it('rejects a null payload entirely', async () => {
    const deps = makeDeps()
    await expect(mirrorGenerateHandler(null, deps)).rejects.toThrow()
  })

  it('rejects an extra unexpected top-level field type mismatch (accountId as object)', async () => {
    const deps = makeDeps()
    await expect(
      mirrorGenerateHandler(basePayload({ accountId: { toString: () => '1' } }), deps),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Message-ref → body fetch: renderer never supplies body text
// ---------------------------------------------------------------------------

describe('ai:threadSummary:generate — message ref resolution (trusted body source)', () => {
  it('fetches bodies from the local DB by (accountId, folder, uid) — never trusts a renderer-supplied body', async () => {
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow({ bodyText: 'DB-sourced body' })) })
    await mirrorGenerateHandler(basePayload(), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    for (const m of call.messages) {
      expect(m.body).toBe('DB-sourced body')
    }
  })

  it('skips message refs the DB cannot resolve (getMessageByUid returns undefined) rather than throwing', async () => {
    const rows = [makeRow(), undefined, makeRow()]
    let i = 0
    const deps = makeDeps({ getMessageByUid: vi.fn(() => rows[i++]) })
    const res = await mirrorGenerateHandler(basePayload({ messages: refs(3) }), deps)
    // Only 2 of 3 refs resolved — still >= MIN_SUMMARY_MESSAGES? No: MIN=3, so this
    // must refuse too_short since only 2 messages resolved.
    expect(res).toEqual({ ok: false, reason: 'too_short' })
  })

  it('refuses too_short when ALL refs are unresolved (e.g. deleted/expunged messages)', async () => {
    const deps = makeDeps({ getMessageByUid: vi.fn(() => undefined) })
    const res = await mirrorGenerateHandler(basePayload(), deps)
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    expect(deps.generateThreadSummary).not.toHaveBeenCalled()
  })

  it('IGNORES a renderer-supplied messageId — the identity token comes ONLY from the DB row', async () => {
    // DISTINCT DB rows per uid (distinct DB Message-IDs) so the thread has ≥3
    // distinct messages after dedup; each ref carries a FORGED renderer messageId
    // that must be ignored in favour of the DB row's Message-ID.
    const byUid: Record<number, MessageRow> = {
      1: makeRow({ messageId: '<db-id-1@x>' }),
      2: makeRow({ messageId: '<db-id-2@x>' }),
      3: makeRow({ messageId: '<db-id-3@x>' }),
    }
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => byUid[uid]),
    })
    const msgs = [
      { folder: 'INBOX', uid: 1, messageId: '<forged-caller-id@x>' },
      { folder: 'INBOX', uid: 2, messageId: '<forged-2@x>' },
      { folder: 'INBOX', uid: 3, messageId: '<forged-3@x>' },
    ]
    await mirrorGenerateHandler(basePayload({ messages: msgs }), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // The DB row's Message-ID wins — the renderer's forged value never appears.
    expect(call.messages.map((m: ThreadSummaryMessage) => m.identityToken)).toEqual([
      '<db-id-1@x>', '<db-id-2@x>', '<db-id-3@x>',
    ])
    for (const m of call.messages) {
      expect(m.identityToken).not.toContain('forged')
    }
  })

  it('falls back to a synthetic account:folder:uid identity token when the DB row has no Message-ID (renderer messageId ignored)', async () => {
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow({ messageId: null })) })
    const msgs = [
      // Even with a renderer messageId present, the DB has none → synthetic key.
      { folder: 'INBOX', uid: 7, messageId: '<forged@x>' },
      { folder: 'INBOX', uid: 8 },
      { folder: 'INBOX', uid: 9 },
    ]
    await mirrorGenerateHandler(basePayload({ accountId: 1, messages: msgs }), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.messages[0].identityToken).toBe('1:INBOX:7')
  })

  it('skips empty-body rows (headers-only / partial cache) and refuses too_short when < 3 have content', async () => {
    // 3 refs, but two rows have empty/whitespace bodies → only 1 real message.
    const rows = [
      makeRow({ bodyText: 'real content' }),
      makeRow({ bodyText: '' }),
      makeRow({ bodyText: '   ' }),
    ]
    let i = 0
    const deps = makeDeps({ getMessageByUid: vi.fn(() => rows[i++]) })
    const res = await mirrorGenerateHandler(basePayload({ messages: refs(3) }), deps)
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    expect(deps.generateThreadSummary).not.toHaveBeenCalled()
  })

  it('never passes an empty-body message to the generator', async () => {
    const rows = [
      makeRow({ bodyText: 'AAA' }),
      makeRow({ bodyText: '' }),   // dropped
      makeRow({ bodyText: 'CCC' }),
      makeRow({ bodyText: 'DDD' }),
    ]
    let i = 0
    const deps = makeDeps({ getMessageByUid: vi.fn(() => rows[i++]) })
    await mirrorGenerateHandler(basePayload({ messages: refs(4) }), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.messages).toHaveLength(3)
    for (const m of call.messages) {
      expect(m.body.trim().length).toBeGreaterThan(0)
    }
  })

  it('passes String(accountId) to the generator (TEXT-account scope for cache + deletion alignment)', async () => {
    const deps = makeDeps()
    await mirrorGenerateHandler(basePayload({ accountId: 42 }), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.accountId).toBe('42')
    expect(typeof call.accountId).toBe('string')
  })

  it('caps refs at AI_SUMMARY_MAX_MESSAGES by taking the newest (slice from the end)', async () => {
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow()) })
    await mirrorGenerateHandler(basePayload({ messages: refs(50) }), deps)
    expect(deps.getMessageByUid).toHaveBeenCalledTimes(50)
  })

  // ── Gate-dedup gap (MEDIUM) ────────────────────────────────────────────────
  //
  // The ≥MIN gate must count DISTINCT resolved messages, not refs. Repeating the
  // same (folder, uid) ref resolves the same DB row → the same identity token;
  // computeThreadHash later collapses that back to ONE message, so without dedup
  // a single message masquerades as a 3-message thread and generates a summary
  // for a one-message "thread". Dedup by resolved identity closes that.

  it('refuses too_short when the SAME (folder, uid) ref is repeated 3× (one real message)', async () => {
    // Every ref resolves the SAME row with a stable Message-ID → one identity.
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow({ messageId: '<only-one@x>' })) })
    const dupRefs = [
      { folder: 'INBOX', uid: 5 },
      { folder: 'INBOX', uid: 5 },
      { folder: 'INBOX', uid: 5 },
    ]
    const res = await mirrorGenerateHandler(basePayload({ messages: dupRefs }), deps)
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    // A single message must never reach the generator dressed as a 3-message thread.
    expect(deps.generateThreadSummary).not.toHaveBeenCalled()
  })

  it('dedups by SYNTHETIC identity (no Message-ID) — repeated (folder, uid) counts once → too_short', async () => {
    // No Message-ID → synthetic account:folder:uid key; the same (folder, uid)
    // repeated resolves the same synthetic identity, so it is one distinct message.
    const deps = makeDeps({ getMessageByUid: vi.fn(() => makeRow({ messageId: null })) })
    const dupRefs = [
      { folder: 'INBOX', uid: 9 },
      { folder: 'INBOX', uid: 9 },
      { folder: 'INBOX', uid: 9 },
    ]
    const res = await mirrorGenerateHandler(basePayload({ messages: dupRefs }), deps)
    expect(res).toEqual({ ok: false, reason: 'too_short' })
    expect(deps.generateThreadSummary).not.toHaveBeenCalled()
  })

  it('counts distinct messages, not refs: 3 distinct + 2 duplicates → generates with only the 3 distinct', async () => {
    // Rows keyed by uid, each with a stable distinct Message-ID; uid 1 and 2 are
    // repeated, so 5 refs collapse to 3 distinct identities.
    const byUid: Record<number, MessageRow> = {
      1: makeRow({ messageId: '<m1@x>', bodyText: 'AAA' }),
      2: makeRow({ messageId: '<m2@x>', bodyText: 'BBB' }),
      3: makeRow({ messageId: '<m3@x>', bodyText: 'CCC' }),
    }
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => byUid[uid]),
    })
    const mixedRefs = [
      { folder: 'INBOX', uid: 1 },
      { folder: 'INBOX', uid: 1 }, // dup of m1
      { folder: 'INBOX', uid: 2 },
      { folder: 'INBOX', uid: 2 }, // dup of m2
      { folder: 'INBOX', uid: 3 },
    ]
    const res = await mirrorGenerateHandler(basePayload({ messages: mixedRefs }), deps)
    expect(res.ok).toBe(true)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Only the 3 DISTINCT identities reached the generator — duplicates dropped.
    expect(call.messages).toHaveLength(3)
    expect(call.messages.map((m: ThreadSummaryMessage) => m.identityToken)).toEqual([
      '<m1@x>', '<m2@x>', '<m3@x>',
    ])
  })
})

// ---------------------------------------------------------------------------
// Provider selection wiring
// ---------------------------------------------------------------------------

describe('ai:threadSummary:generate — provider selection wiring', () => {
  it('passes an empty-string provider (never undefined/null) to the generator when none is configured', async () => {
    const deps = makeDeps({ selectSummaryProvider: vi.fn(() => ({ provider: null, wasLocal: false })) })
    await mirrorGenerateHandler(basePayload(), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.provider).toBe('')
  })

  it('forwards wasLocal from the provider selection through to the generator call', async () => {
    const deps = makeDeps({ selectSummaryProvider: vi.fn(() => ({ provider: 'local', wasLocal: true })) })
    await mirrorGenerateHandler(basePayload(), deps)
    const call = (deps.generateThreadSummary as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.wasLocal).toBe(true)
    expect(call.provider).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// Mirror: §2.51 atomic budget admission wiring
// (electron/main.ts `buildThreadSummaryDeps` / `threadSummaryBudgetWindows` /
// `threadSummaryReservationUsd`). Keep in sync with those functions.
// ---------------------------------------------------------------------------
//
// The GENERATOR contract (reserve before the call, settle after, release on
// failure, fail-closed deny) is owned by
// `electron/services/aiThreadSummary.test.ts`. What is mirrored here is the
// MAIN-side wiring the generator receives:
//   - DELEGATION of the daily/monthly windows to the SHARED `budgetWindows()`
//     exported by electron/services/ai.ts, forwarded verbatim. The math itself
//     (local midnight / month-1st boundaries, $5 / $100 defaults) is asserted
//     against the REAL helper in electron/services/ai.test.ts — re-deriving it
//     here would only prove this file agrees with its own copy, which is exactly
//     the drift that let the ENFORCED cap disagree with the `checkBudgetLimits`
//     text shown to users;
//   - the reservation being attributed to the SELECTED provider;
//   - a reservation amount that is always a valid (finite, > 0) input;
//   - fail-closed propagation: a throwing meter is reported to Sentry AND
//     RETHROWN, because the generator turns that throw into a hard budget deny.

/** Local stand-in for `AiBudgetReserveError` (packages/db). Not imported: this
 *  file deliberately avoids the native better-sqlite3 module graph. */
class FakeReserveError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = 'AiBudgetReserveError'
  }
}

interface MirrorSettings {
  aiModel?: string
  aiDailyBudgetUsd?: number
  aiMonthlyBudgetUsd?: number
}

interface BudgetWindow { sinceIso: string; limitUsd: number }

type AdmitFn = MirrorAdmitDeps['admitAiReservation']
type CaptureFn = MirrorAdmitDeps['captureException']

/**
 * Stand-in for the SHARED `budgetWindows()` that main.ts imports from
 * `electron/services/ai.ts`.
 *
 * Deliberately NOT a re-implementation of the window math. main.ts used to carry
 * its own copy (`threadSummaryBudgetWindows`); that copy is gone, and a copy here
 * would be just as wrong — asserting `$5` / `$100` / local-midnight against a
 * local reimplementation proves nothing about the real helper, it only proves
 * this file agrees with itself. Those assertions now run against the REAL
 * exported function in `electron/services/ai.test.ts`
 * ("budgetWindows — shared window math (§2.51)").
 *
 * This file cannot import the real one: `services/ai.ts` pulls in `packages/db`
 * and therefore the native better-sqlite3 module graph, which this suite avoids
 * on purpose. So the helper is injected as a dep and returns an opaque sentinel —
 * what IS mirrored here is the WIRING invariant: whatever the shared helper
 * returns must reach `admitAiReservation` verbatim, unfiltered and unreordered.
 */
const SHARED_WINDOWS_SENTINEL: BudgetWindow[] = [
  { sinceIso: '2026-07-24T00:00:00.000Z', limitUsd: 5 },
  { sinceIso: '2026-07-01T00:00:00.000Z', limitUsd: 100 },
]

/** Mirrors `threadSummaryReservationUsd` in electron/main.ts. `reserve` stands
 *  in for the core `nullUsageReservationUsd` (pure, model-aware floor). */
function mirrorReservationUsd(model: string, reserve: (m: string) => number, floor = 0.05): number {
  const reserved = reserve(model)
  return Number.isFinite(reserved) && reserved > 0 ? reserved : floor
}

interface MirrorAdmitDeps {
  getSettings: () => MirrorSettings
  admitAiReservation: (
    accountId: string,
    provider: string,
    model: string | null,
    reservationUsd: number,
    windows: BudgetWindow[],
  ) => { ok: true; reservation: { id: number } } | { ok: false; reason: 'over-cap' }
  captureException: (err: unknown, ctx: Record<string, unknown>) => void
  nullUsageReservationUsd: (model: string) => number
  /** Stands in for the SHARED `budgetWindows()` imported from services/ai. */
  budgetWindows: (settings: MirrorSettings) => BudgetWindow[]
}

/** Mirrors the `admitBudget` dep built by `buildThreadSummaryDeps`. */
function mirrorAdmitBudget(accountId: string, provider: string, deps: MirrorAdmitDeps) {
  return () => {
    const settings = deps.getSettings()
    const model = settings.aiModel || ''
    try {
      return deps.admitAiReservation(
        accountId,
        provider,
        settings.aiModel || null,
        mirrorReservationUsd(model, deps.nullUsageReservationUsd),
        deps.budgetWindows(settings),
      )
    } catch (err) {
      deps.captureException(err, {
        source: 'ai.threadSummary.budget.reserve',
        ...(err instanceof FakeReserveError ? { reserve_reason: err.reason } : {}),
      })
      throw err
    }
  }
}

function makeAdmitDeps(overrides: Partial<MirrorAdmitDeps> = {}): MirrorAdmitDeps {
  return {
    getSettings: () => ({ aiModel: 'gpt-4o-mini' }),
    admitAiReservation: vi.fn<AdmitFn>(() => ({ ok: true as const, reservation: { id: 7 } })),
    captureException: vi.fn(),
    nullUsageReservationUsd: () => 0.05,
    budgetWindows: () => SHARED_WINDOWS_SENTINEL,
    ...overrides,
  }
}

describe('ai:threadSummary:generate — §2.51 budget admission wiring', () => {
  it('reserves against the SELECTED provider and the TEXT account id', () => {
    const admitSpy = vi.fn<AdmitFn>(() => ({ ok: true as const, reservation: { id: 7 } }))
    const deps = makeAdmitDeps({ admitAiReservation: admitSpy })
    mirrorAdmitBudget('42', 'gemini-api', deps)()
    expect(admitSpy).toHaveBeenCalledTimes(1)
    const [accountId, provider, model, amount] = admitSpy.mock.calls[0]
    expect(accountId).toBe('42')
    expect(provider).toBe('gemini-api')
    expect(model).toBe('gpt-4o-mini')
    expect(amount).toBeGreaterThan(0)
    expect(Number.isFinite(amount)).toBe(true)
  })

  // §2.51 — main.ts must DELEGATE the window math, not re-derive it. The daily /
  // monthly boundaries and the $5 / $100 defaults are asserted against the real
  // exported helper in electron/services/ai.test.ts; what matters HERE is that
  // main.ts forwards that helper's output untouched. A regression where main.ts
  // reintroduces a local copy, filters "unlimited" windows, or reorders them
  // would break this without any window arithmetic being duplicated in the test.
  it('forwards the SHARED budgetWindows() output to admitAiReservation verbatim', () => {
    const admitSpy = vi.fn<AdmitFn>(() => ({ ok: true as const, reservation: { id: 7 } }))
    const sharedWindows = vi.fn(() => SHARED_WINDOWS_SENTINEL)
    const deps = makeAdmitDeps({ admitAiReservation: admitSpy, budgetWindows: sharedWindows })
    mirrorAdmitBudget('1', 'openai-api', deps)()
    expect(sharedWindows).toHaveBeenCalledTimes(1)
    expect(admitSpy.mock.calls[0][4]).toBe(SHARED_WINDOWS_SENTINEL)
  })

  it('reads the windows from the CURRENT settings snapshot', () => {
    // The shared helper is called with the settings main.ts just resolved, so a
    // limit the user changed mid-session is picked up on the next generation.
    const settings = { aiModel: 'gpt-4o-mini', aiDailyBudgetUsd: 0.2, aiMonthlyBudgetUsd: 3 }
    const sharedWindows = vi.fn(() => SHARED_WINDOWS_SENTINEL)
    const deps = makeAdmitDeps({ getSettings: () => settings, budgetWindows: sharedWindows })
    mirrorAdmitBudget('1', 'openai-api', deps)()
    expect(sharedWindows).toHaveBeenCalledWith(settings)
  })

  it('does NOT filter out an "unlimited" (non-positive) window before admission', () => {
    // The `> 0` guard lives in the consumers (checkBudgetLimits and the db
    // primitive), so main.ts must pass non-positive limits straight through —
    // dropping them here would be a silent behaviour fork.
    const unlimited: BudgetWindow[] = [
      { sinceIso: '2026-07-24T00:00:00.000Z', limitUsd: 0 },
      { sinceIso: '2026-07-01T00:00:00.000Z', limitUsd: -1 },
    ]
    const admitSpy = vi.fn<AdmitFn>(() => ({ ok: true as const, reservation: { id: 7 } }))
    const deps = makeAdmitDeps({ admitAiReservation: admitSpy, budgetWindows: () => unlimited })
    mirrorAdmitBudget('1', 'openai-api', deps)()
    expect(admitSpy.mock.calls[0][4]).toEqual(unlimited)
  })

  it('never reserves a non-positive amount, even if the model floor returns garbage', () => {
    // A zero/NaN reservation would throw invalid-amount inside the primitive and
    // DENY a legitimate call — the defensive floor keeps the input valid.
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const admitSpy = vi.fn<AdmitFn>(() => ({ ok: true as const, reservation: { id: 7 } }))
      const deps = makeAdmitDeps({ admitAiReservation: admitSpy, nullUsageReservationUsd: () => bogus })
      mirrorAdmitBudget('1', 'openai-api', deps)()
      const amount = admitSpy.mock.calls[0][3]
      expect(Number.isFinite(amount)).toBe(true)
      expect(amount).toBeGreaterThan(0)
    }
  })

  it('returns the over-cap denial VERBATIM (an ordinary refusal, not an error)', () => {
    const deps = makeAdmitDeps({
      admitAiReservation: vi.fn<AdmitFn>(() => ({ ok: false as const, reason: 'over-cap' as const })),
    })
    expect(mirrorAdmitBudget('1', 'openai-api', deps)()).toEqual({ ok: false, reason: 'over-cap' })
    expect(deps.captureException).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED: reports a reserve failure to Sentry and RETHROWS it', () => {
    // Rethrowing is what makes the deny hard: the generator maps any throw to a
    // structured budget refusal. Swallowing here would silently un-cap spend.
    const err = new FakeReserveError('ledger-write-failed', 'failed to book reservation')
    const capture = vi.fn<CaptureFn>()
    const deps = makeAdmitDeps({
      admitAiReservation: vi.fn<AdmitFn>(() => { throw err }),
      captureException: capture,
    })
    expect(() => mirrorAdmitBudget('1', 'openai-api', deps)()).toThrow(err)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0][0]).toBe(err)
    expect(capture.mock.calls[0][1]).toEqual({
      source: 'ai.threadSummary.budget.reserve',
      reserve_reason: 'ledger-write-failed',
    })
  })

  it('FAIL-CLOSED: an unexpected (non-reserve) throw is also reported and rethrown', () => {
    const err = new Error('sqlite is on fire')
    const capture = vi.fn<CaptureFn>()
    const deps = makeAdmitDeps({
      admitAiReservation: vi.fn<AdmitFn>(() => { throw err }),
      captureException: capture,
    })
    expect(() => mirrorAdmitBudget('1', 'openai-api', deps)()).toThrow(err)
    // No `reserve_reason` for a non-AiBudgetReserveError — and no PII: only the
    // aggregate source label is attached.
    expect(capture.mock.calls[0][1]).toEqual({ source: 'ai.threadSummary.budget.reserve' })
  })
})

// ---------------------------------------------------------------------------
// Per-account single-flight — serialization contract
// ---------------------------------------------------------------------------
//
// Since §2.51 the budget cap itself is HARD (atomic admission: projected check +
// reservation insert in one `BEGIN IMMEDIATE` tx before the provider call, and
// fail-closed on a meter failure), so this wrapper is no longer what keeps a
// concurrent flood under the cap. What it still does is SERIALIZE generations
// per account — at most one in flight, the second starting only after the first
// SETTLES — which contains latency/duplicate work and cuts this surface's
// contribution to the residual N-call overshoot (each admitted reservation is a
// conservative FLOOR, so N in-flight calls may each settle above it) down to ~1
// per account. Unrelated accounts must NOT be serialized against each other.
//
// A "generate step" here is the `generateThreadSummary` call — the point that
// performs the budget admission + provider spend. These tests assert non-overlap
// of that step for the same account, and permitted overlap across accounts,
// using a controllable deferred generator.

/** A generator whose Nth call blocks until the test resolves its deferred.
 *  Records how many are concurrently inside the generate step. */
function makeControllableGenerator() {
  const deferreds: Array<{ resolve: (v: ThreadSummaryOutcome) => void; reject: (e: unknown) => void }> = []
  let active = 0
  let maxConcurrent = 0
  const enteredOrder: number[] = []
  const generate = vi.fn(async (opts: { accountId: string }): Promise<ThreadSummaryOutcome> => {
    active += 1
    maxConcurrent = Math.max(maxConcurrent, active)
    enteredOrder.push(Number(opts.accountId))
    try {
      return await new Promise<ThreadSummaryOutcome>((resolve, reject) => {
        deferreds.push({ resolve, reject })
      })
    } finally {
      active -= 1
    }
  })
  return {
    generate,
    /** Number of generate calls that have STARTED (entered the step). */
    started: () => deferreds.length,
    /** Peak simultaneous in-step count observed. */
    maxConcurrent: () => maxConcurrent,
    enteredOrder: () => enteredOrder,
    /** Resolve the Nth (0-based) started generate call with a success outcome. */
    resolveAt: (i: number) =>
      deferreds[i].resolve({
        ok: true,
        summary: {
          threadHash: `h${i}`, oneLine: 'ol', bullets: ['a', 'b', 'c', 'd', 'e'],
          provider: 'anthropic-api', cached: false, wasLocal: false, createdAt: 1,
        },
      }),
    rejectAt: (i: number, err: unknown) => deferreds[i].reject(err),
  }
}

/** Distinct message refs per call so each request is a distinct thread (distinct
 *  hash → cache miss → its own provider call), matching the flood the fix bounds. */
function distinctRefs(startUid: number) {
  return [
    { folder: 'INBOX', uid: startUid },
    { folder: 'INBOX', uid: startUid + 1 },
    { folder: 'INBOX', uid: startUid + 2 },
  ]
}

/** Yield one macrotask so queued microtasks AND chained async bodies advance. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Poll `cond` across macrotask ticks until it holds or the attempt budget is
 *  exhausted. Used instead of a fixed number of microtask flushes because a
 *  chained request has to walk several `await`s (predecessor settle → .then →
 *  async handler body → generate step) before it becomes observable. */
async function waitFor(cond: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !cond(); i += 1) {
    await tick()
  }
}

describe('ai:threadSummary:generate — per-account single-flight (budget TOCTOU defense)', () => {
  it('serializes two concurrent generations for the SAME account: the second generate step starts only after the first settles', async () => {
    const gen = makeControllableGenerator()
    // Distinct DB rows per uid so each request builds a distinct thread and each
    // reaches the generate step (never short-circuits to too_short/opt_out).
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => makeRow({ messageId: `<m${uid}@x>` })),
      generateThreadSummary: gen.generate,
    })
    const handler = makeSerializedHandler(deps)

    // Fire two concurrent requests for the SAME account with DISTINCT threads.
    const p1 = handler({ accountId: 1, messages: distinctRefs(1) })
    const p2 = handler({ accountId: 1, messages: distinctRefs(100) })

    // Only the FIRST enters the generate step; the second waits on the in-flight
    // chain (it must not have called the provider yet).
    await waitFor(() => gen.started() >= 1)
    // Give the second request every chance to (wrongly) enter too — it must not.
    await waitFor(() => gen.started() >= 2, 5)
    expect(gen.started()).toBe(1)
    expect(gen.maxConcurrent()).toBe(1)

    // Settle the first — this is the point its cost would be booked.
    gen.resolveAt(0)

    // Now the second is allowed to enter its own generate step.
    await waitFor(() => gen.started() >= 2)
    expect(gen.started()).toBe(2)
    expect(gen.maxConcurrent()).toBe(1) // never overlapped

    gen.resolveAt(1)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    // The two never overlapped inside the generate step (bounds the burst).
    expect(gen.maxConcurrent()).toBe(1)
  })

  it('does NOT serialize across DIFFERENT accounts: two accounts may run their generate steps concurrently', async () => {
    const gen = makeControllableGenerator()
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => makeRow({ messageId: `<m${uid}@x>` })),
      generateThreadSummary: gen.generate,
    })
    const handler = makeSerializedHandler(deps)

    // One request per DISTINCT account, concurrently.
    const pA = handler({ accountId: 1, messages: distinctRefs(1) })
    const pB = handler({ accountId: 2, messages: distinctRefs(1) })

    // Both enter the generate step concurrently — accounts are independent.
    await waitFor(() => gen.started() >= 2)
    expect(gen.started()).toBe(2)
    expect(gen.maxConcurrent()).toBe(2)

    gen.resolveAt(0)
    gen.resolveAt(1)
    const [rA, rB] = await Promise.all([pA, pB])
    expect(rA.ok).toBe(true)
    expect(rB.ok).toBe(true)
  })

  it('does not poison the per-account chain when the first request REJECTS: the second still runs its own generate step', async () => {
    const gen = makeControllableGenerator()
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => makeRow({ messageId: `<m${uid}@x>` })),
      generateThreadSummary: gen.generate,
    })
    const handler = makeSerializedHandler(deps)

    const p1 = handler({ accountId: 1, messages: distinctRefs(1) })
    const p2 = handler({ accountId: 1, messages: distinctRefs(100) })
    // Prevent an unhandled-rejection warning on the first (it is expected to reject).
    p1.catch(() => undefined)

    await waitFor(() => gen.started() >= 1)
    expect(gen.started()).toBe(1)

    // First request fails (e.g. provider error) — must NOT block the chain.
    gen.rejectAt(0, new Error('provider blew up'))

    // The second request proceeds to its own generate step despite the failure.
    await waitFor(() => gen.started() >= 2)
    expect(gen.started()).toBe(2)
    gen.resolveAt(1)
    const r2 = await p2
    expect(r2.ok).toBe(true)
    await expect(p1).rejects.toThrow('provider blew up')
  })

  it('a request refused BEFORE the generate step (opt_out) still holds the slot until it settles, then releases it', async () => {
    const gen = makeControllableGenerator()
    // Account 1 is opted OUT → refuses without ever calling generate; account 1's
    // slot must still be released so a later request for account 1 can run.
    const deps = makeDeps({
      isThreadSummaryEnabledForAccount: vi.fn(() => true),
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => makeRow({ messageId: `<m${uid}@x>` })),
      generateThreadSummary: gen.generate,
    })
    // Toggle: first call opted OUT, subsequent calls opted IN.
    let calls = 0
    ;(deps.isThreadSummaryEnabledForAccount as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1
      return calls > 1
    })
    const handler = makeSerializedHandler(deps)

    const p1 = handler({ accountId: 1, messages: distinctRefs(1) })
    const r1 = await p1
    expect(r1).toEqual({ ok: false, reason: 'opt_out' })
    expect(gen.started()).toBe(0) // opted out — no generate step

    // The slot released; a follow-up for account 1 now runs its generate step.
    const p2 = handler({ accountId: 1, messages: distinctRefs(100) })
    await waitFor(() => gen.started() >= 1)
    expect(gen.started()).toBe(1)
    gen.resolveAt(0)
    const r2 = await p2
    expect(r2.ok).toBe(true)
  })

  it('three concurrent requests for the SAME account run strictly one-at-a-time (never >1 in the generate step)', async () => {
    const gen = makeControllableGenerator()
    const deps = makeDeps({
      getMessageByUid: vi.fn((_a: number, _f: string, uid: number) => makeRow({ messageId: `<m${uid}@x>` })),
      generateThreadSummary: gen.generate,
    })
    const handler = makeSerializedHandler(deps)

    const p1 = handler({ accountId: 1, messages: distinctRefs(1) })
    const p2 = handler({ accountId: 1, messages: distinctRefs(100) })
    const p3 = handler({ accountId: 1, messages: distinctRefs(200) })

    await waitFor(() => gen.started() >= 1)
    expect(gen.started()).toBe(1)
    gen.resolveAt(0)
    await waitFor(() => gen.started() >= 2)
    expect(gen.started()).toBe(2)
    gen.resolveAt(1)
    await waitFor(() => gen.started() >= 3)
    expect(gen.started()).toBe(3)
    gen.resolveAt(2)

    await Promise.all([p1, p2, p3])
    // Peak simultaneous in-step count never exceeded 1 → burst bounded to 1.
    expect(gen.maxConcurrent()).toBe(1)
    // Order is FIFO-preserved for the same account.
    expect(gen.enteredOrder()).toEqual([1, 1, 1])
  })
})
