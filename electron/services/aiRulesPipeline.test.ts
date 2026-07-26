import { describe, it, expect, beforeEach } from 'vitest'
import {
  createRateLimitState,
  enqueueForAiRules,
  processAiRuleBatch,
  parseAllowedActions,
  accountFolderSet,
  type AiRulesPipelineDeps,
  type AiRulePipelineRule,
  type AiRulePipelineChatResult,
  type AiRuleAuditWrite,
  type AiRuleRateLimitState,
} from './aiRulesPipeline'
import {
  AI_RULE_QUEUE_MAX,
  AI_RULE_BATCH_SIZE,
  AI_RULE_MAX_CALLS_PER_HOUR,
  AI_RULE_MAX_ENABLED_PER_ACCOUNT,
  AI_RULE_NULL_USAGE_COST_FLOOR,
  type AiRulePendingItem,
  type RuleAction,
} from '../../packages/core'

// ── Test harness: drive the REAL pipeline with injected fakes ──────────────
//
// These tests exercise the production orchestration (processAiRuleBatch)
// directly, so a regression that removes a cap, auto-applies trash, or drops
// un-triaged items WILL turn a test red — unlike a "mirror" test that
// re-implements the loop.
//
// §2.39 simplification: the pipeline is now STATELESS-PER-TICK and
// ATOMIC-PER-ACCOUNT. There is no per-item rule cursor, no per-item pending
// retry, and no cross-tick un-persisted budget carry. An account is either
// fully triaged in one tick or requeued whole for a from-scratch retry. The
// config-time per-account enabled-rule cap
// (AI_RULE_MAX_ENABLED_PER_ACCOUNT <= AI_RULE_MAX_CALLS_PER_HOUR) guarantees a
// full account rule set always fits one fresh hourly window, so the atomic
// model always terminates.

interface Recorded {
  chatCalls: Array<{ systemPrompt: string; userPrompt: string }>
  executed: Array<{ accountId: number; folder: string; uid: number; action: RuleAction }>
  ruleLog: Array<{ aiRuleId: string; accountId: string; uid: number; actionTaken: string; reasoning?: string }>
  auditRows: AiRuleAuditWrite[]
  events: Array<{ name: string; tags: Record<string, string> }>
}

interface HarnessOptions {
  rules?: AiRulePipelineRule[]
  /** Given (accountId, subBatchSize, ruleId) return the raw model text, or null
   *  to simulate a provider error. */
  respond?: (accountId: number, subBatchSize: number, ruleId: string) => string | null
  /** Per-call response keyed on the ACTUAL built userPrompt (which embeds the
   *  rule's unique prompt prefix + the per-account email blocks) and the global
   *  call index. Return null to simulate a provider error. Takes precedence over
   *  `respond`. Lets a test target one account's rule precisely. */
  respondFor?: (userPrompt: string, callIndex: number) => string | null
  /** When true, `sumRuleCostSince` returns `spentToday` PLUS the sum of every
   *  rule cost persisted to the audit log so far — mirroring production's
   *  cross-tick budget baseline. Off by default so single-tick tests keep a
   *  constant baseline. */
  dynamicSpend?: boolean
  /** Usage returned alongside each successful response (drives cost). */
  usage?: () => AiRulePipelineChatResult['usage']
  model?: string
  mailboxCache?: Record<number, Array<{ path: string }>>
  spentToday?: number
  /** Called on each executeRuleAction to allow injecting a failure. */
  onExecute?: (a: { accountId: number; uid: number; action: RuleAction }) => void
  now?: () => number
  /** Awaited inside aiChatSimple BEFORE it resolves — lets a test hold a batch
   *  open (single-flight / concurrency assertions). */
  beforeChat?: () => Promise<void>
  /** Override getMailboxCache to inject a fault (exception-requeue test). */
  getMailboxCache?: () => Record<number, Array<{ path: string }>>
  /** Override isShuttingDown (early-return branch test). */
  isShuttingDown?: () => boolean
}

function rule(overrides: Partial<AiRulePipelineRule> = {}): AiRulePipelineRule {
  return {
    id: 'r1',
    accountId: null,
    enabled: true,
    prompt: 'classify',
    allowedActions: JSON.stringify(['archive', 'move', 'mark_read', 'mark_starred', 'trash', 'mark_spam']),
    budgetPerDayUsd: 1.0,
    ...overrides,
  }
}

function item(uid: number, accountId = 1): AiRulePendingItem {
  return {
    accountId,
    folder: 'INBOX',
    uid,
    from: 'a@b.com',
    to: 'me@b.com',
    subject: `s${uid}`,
    bodyPreview: `body ${uid}`,
    hasAttachment: false,
  }
}

function makeHarness(opts: HarnessOptions = {}): {
  deps: AiRulesPipelineDeps
  rate: AiRuleRateLimitState
  rec: Recorded
  queue: AiRulePendingItem[]
} {
  const queue: AiRulePendingItem[] = []
  const rec: Recorded = { chatCalls: [], executed: [], ruleLog: [], auditRows: [], events: [] }
  const rules = opts.rules ?? [rule()]
  const respond = opts.respond ?? (() => JSON.stringify([]))
  const usage = opts.usage ?? (() => ({ inputTokens: 100, outputTokens: 100 }))
  const model = opts.model ?? 'gpt-4o-mini'
  const mailboxCache = opts.mailboxCache ?? { 1: [{ path: 'INBOX' }, { path: 'Archive' }], 2: [{ path: 'INBOX' }], 3: [{ path: 'INBOX' }] }
  const spentToday = opts.spentToday ?? 0

  const deps: AiRulesPipelineDeps = {
    queue,
    isShuttingDown: opts.isShuttingDown ?? (() => false),
    listAiRules: () => rules,
    // Mirror production semantics: the daily-budget baseline is the sum of the
    // persisted `goal='rule'` audit rows since midnight. We model that as the
    // fixed `spentToday` seed PLUS every rule cost this harness has actually
    // written to `rec.auditRows`. Within a single tick `sumRuleCostSince` is
    // read once, before any of this tick's rows exist, so it returns exactly
    // `spentToday` (backward-compatible). ACROSS ticks the persisted rows
    // accumulate — which is what the cross-tick budget test needs.
    sumRuleCostSince: opts.dynamicSpend
      ? () =>
          spentToday +
          rec.auditRows.reduce(
            (s, r) =>
              r.goal === 'rule' && typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)
                ? s + r.costUsd
                : s,
            0,
          )
      : () => spentToday,
    getMailboxCache: opts.getMailboxCache ?? (() => mailboxCache),
    aiChatSimple: async (systemPrompt, userPrompt) => {
      rec.chatCalls.push({ systemPrompt, userPrompt })
      if (opts.beforeChat) await opts.beforeChat()
      // A test may override the response per call from the actual prompt text
      // (e.g. to target a specific account's rule by its unique prompt prefix).
      if (opts.respondFor) {
        const text = opts.respondFor(userPrompt, rec.chatCalls.length - 1)
        if (text === null) return null
        return { text, model, usage: usage() }
      }
      const text = pendingRespond(systemPrompt, userPrompt)
      if (text === null) return null
      return { text, model, usage: usage() }
    },
    executeRuleAction: async (accountId, folder, uid, action) => {
      rec.executed.push({ accountId, folder, uid, action })
      opts.onExecute?.({ accountId, uid, action })
    },
    insertAiRuleLog: (data) => {
      // Capture `reasoning` verbatim (including `undefined`) so a test can assert
      // the pipeline NEVER passes model-generated free-text into the durable log
      // (§2.39 MEDIUM — PII must not be minted into ai_rule_log).
      rec.ruleLog.push({ aiRuleId: data.aiRuleId, accountId: data.accountId, uid: data.uid, actionTaken: data.actionTaken, reasoning: data.reasoning })
    },
    appendAiActionLog: (row) => {
      rec.auditRows.push(row)
    },
    getProviderModel: () => ({ provider: 'openai-api', model }),
    recordEvent: (name, tags) => { rec.events.push({ name, tags }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: opts.now ?? (() => 1_000),
  }

  // The respond callback wants (accountId, subBatchSize, ruleId); we recover the
  // sub-batch size by parsing the userPrompt the pipeline actually built. The
  // default respond ignores accountId/ruleId; tests that need per-rule branching
  // use `respondFor` keyed on the unique rule prompt prefix.
  let callIndex = 0
  const respondByCall: Array<{ accountId: number; ruleId: string; size: number }> = []
  const pendingRespond = (_sys: string, userPrompt: string): string | null => {
    const size = (userPrompt.match(/Email \d+ \(index \d+\)/g) ?? []).length
    const meta = respondByCall[callIndex] ?? { accountId: 1, ruleId: 'r1', size }
    callIndex++
    return respond(meta.accountId, size, meta.ruleId)
  }

  return { deps, rate: createRateLimitState(), rec, queue }
}

describe('enqueueForAiRules — bounded drop-oldest queue', () => {
  it('caps at AI_RULE_QUEUE_MAX and drops the oldest', () => {
    const queue: AiRulePendingItem[] = []
    for (let i = 0; i < AI_RULE_QUEUE_MAX + 5; i++) enqueueForAiRules(queue, item(i))
    expect(queue.length).toBe(AI_RULE_QUEUE_MAX)
    expect(queue[0].uid).toBe(5)
    expect(queue[queue.length - 1].uid).toBe(AI_RULE_QUEUE_MAX + 4)
  })
})

describe('parseAllowedActions', () => {
  it('parses a well-formed array of known actions', () => {
    expect(parseAllowedActions(JSON.stringify(['archive', 'trash']))).toEqual(['archive', 'trash'])
  })
  it('falls back to the safe default on malformed JSON', () => {
    expect(parseAllowedActions('not json{{{')).toEqual(['archive', 'move', 'mark_read'])
  })
  it('falls back when the JSON is not an array', () => {
    expect(parseAllowedActions(JSON.stringify({ archive: true }))).toEqual(['archive', 'move', 'mark_read'])
  })
  it('filters out unknown action strings', () => {
    expect(parseAllowedActions(JSON.stringify(['archive', 'delete_forever', 'trash']))).toEqual(['archive', 'trash'])
  })
  it('an all-invalid array collapses to an empty allowlist (not the default)', () => {
    expect(parseAllowedActions(JSON.stringify(['nuke']))).toEqual([])
  })
})

describe('accountFolderSet', () => {
  it('builds a folder-path lookup set', () => {
    expect(accountFolderSet(1, { 1: [{ path: 'INBOX' }, { path: 'Archive' }] })).toEqual(new Set(['INBOX', 'Archive']))
  })
  it('empty for an unknown account', () => {
    expect(accountFolderSet(99, {})).toEqual(new Set())
  })
})

describe('processAiRuleBatch — destructive preview/apply invariant', () => {
  it('NEVER auto-applies trash — executor is called 0 times, log records preview_pending', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'trash' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    // The real executor was NOT invoked for the destructive action.
    expect(rec.executed).toHaveLength(0)
    // A preview_pending row was recorded instead.
    expect(rec.ruleLog).toHaveLength(1)
    expect(rec.ruleLog[0].actionTaken).toContain('preview_pending')
    expect(rec.ruleLog[0].actionTaken).toContain('trash')
    expect(rec.events.some(e => e.name === 'ai.rule.destructive_preview')).toBe(true)
  })

  it('NEVER auto-applies mark_spam — executor 0 times, preview recorded', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'mark_spam' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    expect(rec.executed).toHaveLength(0)
    expect(rec.ruleLog[0].actionTaken).toContain('preview_pending')
    expect(rec.ruleLog[0].actionTaken).toContain('mark_spam')
  })

  it('reversible actions ARE auto-applied via the executor', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'archive' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('archive')
    expect(rec.events.some(e => e.name === 'ai.rule.applied')).toBe(true)
  })

  it('a mixed response applies the reversible one and previews the destructive one', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([
        { index: 0, action: 'trash' },
        { index: 1, action: 'archive' },
      ]),
    })
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)

    expect(rec.executed.map(e => ({ uid: e.uid, type: e.action.type }))).toEqual([{ uid: 2, type: 'archive' }])
    const preview = rec.ruleLog.find(r => r.actionTaken.includes('preview_pending'))
    expect(preview?.uid).toBe(1)
  })
})

// §2.39 MEDIUM — model-generated `reasoning` is a PII sink. A prompt-injected
// sender can coax the model to echo the subject / address / a body fragment into
// the per-decision `reasoning` string. parseAiRuleResponse still parses it (for
// in-process diagnostics / local createLogger), but the pipeline must NEVER
// persist it into the durable ai_rule_log — that would mint a second, long-lived
// PII copy that outlives deletion of the source email and surfaces in the
// Settings rule log. These tests assert `reasoning` reaches insertAiRuleLog as
// `undefined` on BOTH the destructive-preview and reversible-apply paths, even
// when the model returns a PII-looking reasoning string.
describe('processAiRuleBatch — model reasoning is NOT persisted to ai_rule_log (PII)', () => {
  const PII_REASONING =
    'Sender john.doe@acme.example wrote "Q3 payroll spreadsheet attached, SSN 123-45-6789"'

  it('destructive-preview path: reasoning is dropped, not written to the rule log', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () =>
        JSON.stringify([{ index: 0, action: 'trash', reasoning: PII_REASONING }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    // A preview row was recorded (destructive is never auto-applied)...
    expect(rec.ruleLog).toHaveLength(1)
    expect(rec.ruleLog[0].actionTaken).toContain('preview_pending')
    // ...but WITHOUT the model-generated reasoning free-text.
    expect(rec.ruleLog[0].reasoning).toBeUndefined()
    // The PII substring appears NOWHERE in the persisted row.
    const persisted = JSON.stringify(rec.ruleLog[0])
    expect(persisted).not.toContain('123-45-6789')
    expect(persisted).not.toContain('john.doe@acme.example')
  })

  it('reversible-apply path: reasoning is dropped, not written to the rule log', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () =>
        JSON.stringify([{ index: 0, action: 'archive', reasoning: PII_REASONING }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    // The reversible action was applied and an execution-log row recorded...
    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('archive')
    expect(rec.ruleLog).toHaveLength(1)
    // ...but the row carries NO model-generated reasoning.
    expect(rec.ruleLog[0].reasoning).toBeUndefined()
    const persisted = JSON.stringify(rec.ruleLog[0])
    expect(persisted).not.toContain('123-45-6789')
    expect(persisted).not.toContain('john.doe@acme.example')
  })
})

// §2.39 MEDIUM — model-generated `folder` is a PII sink for NON-move actions.
// `folder` is only meaningful for `move`; for every other action it is dead, yet
// a prompt-injected sender can coax the model to echo the subject / address / a
// body fragment into `folder` on a `trash`/`archive`/`mark_read` decision. The
// parse boundary strips it, and the pipeline additionally builds the persisted
// `actionTaken` to structurally omit a folder field for non-move actions
// (defense-in-depth). These tests assert the durable ai_rule_log row carries
// NO `folder` key and NONE of the PII string for a non-move action, on BOTH the
// destructive-preview and reversible-apply paths.
describe('processAiRuleBatch — model folder is NOT persisted for non-move actions (PII)', () => {
  const PII_FOLDER = 'victim@example.com "Re: your invoice — SSN 123-45-6789"'

  it('destructive-preview path (trash): no folder key, no PII in the persisted row', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'trash', folder: PII_FOLDER }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    expect(rec.ruleLog).toHaveLength(1)
    expect(rec.ruleLog[0].actionTaken).toContain('preview_pending')
    expect(rec.ruleLog[0].actionTaken).toContain('trash')
    // The persisted actionTaken carries NO folder field for a destructive action.
    const parsed = JSON.parse(rec.ruleLog[0].actionTaken) as Record<string, unknown>
    expect('folder' in parsed).toBe(false)
    // And the PII string appears NOWHERE in the persisted row.
    const persisted = JSON.stringify(rec.ruleLog[0])
    expect(persisted).not.toContain('123-45-6789')
    expect(persisted).not.toContain('victim@example.com')
  })

  it('reversible-apply path (archive): no folder key, no PII in the persisted row', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'archive', folder: PII_FOLDER }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('archive')
    // The executed action itself must not carry the PII folder either.
    expect(rec.executed[0].action.folder).toBeUndefined()
    expect(rec.ruleLog).toHaveLength(1)
    const parsed = JSON.parse(rec.ruleLog[0].actionTaken) as Record<string, unknown>
    expect('folder' in parsed).toBe(false)
    const persisted = JSON.stringify(rec.ruleLog[0])
    expect(persisted).not.toContain('123-45-6789')
    expect(persisted).not.toContain('victim@example.com')
  })

  it('a valid move still persists its folder (regression guard for the move path)', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'move', folder: 'Archive' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)

    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action).toEqual({ type: 'move', folder: 'Archive' })
    const parsed = JSON.parse(rec.ruleLog[0].actionTaken) as Record<string, unknown>
    expect(parsed.folder).toBe('Archive')
  })
})

describe('processAiRuleBatch — reject-by-default reversibility guard', () => {
  it('only positively-reversible actions reach the executor', async () => {
    // parseAiRuleResponse only admits known actions; here both are reversible, so
    // both are executed. The synthetic-unclassified-action branch is proven in
    // aiRulesPipeline.rejectDefault.test.ts (mocks parse to emit an unclassified
    // verb and asserts the executor is never called).
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([
        { index: 0, action: 'mark_read' },
        { index: 1, action: 'mark_starred' },
      ]),
    })
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed.map(e => e.action.type).sort()).toEqual(['mark_read', 'mark_starred'])
  })
})

describe('processAiRuleBatch — strict validation reaches a safe no-op', () => {
  it('prose response requeues the account (transient parse failure, no regex salvage)', async () => {
    // A prose response fails strict validation → the account is incomplete and
    // requeued for retry. Crucially, NO regex-scraped action is executed.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => 'Sure: [{"index":0,"action":"trash"}]',
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
    expect(rec.ruleLog).toHaveLength(0)
    // Requeued (transient), not silently dropped.
    expect(queue.map(q => q.uid)).toEqual([1])
  })

  it('out-of-bounds index is dropped (confirmed no-op)', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 99, action: 'archive' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
    // The response parsed ok (a valid, empty-after-filter decision set) → the
    // account completed as a no-op and drained.
    expect(queue).toHaveLength(0)
  })

  it('move to a hallucinated folder is dropped', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'move', folder: 'DoesNotExist' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
  })

  it('move to a real folder is applied', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'move', folder: 'Archive' }]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action).toEqual({ type: 'move', folder: 'Archive' })
  })

  it('exact index boundaries: batchSize-1 accepted, batchSize rejected', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([
        { index: 1, action: 'archive' },   // batchSize-1 (size 2) → accepted
        { index: 2, action: 'mark_read' }, // == batchSize → rejected
      ]),
    })
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed.map(e => e.uid)).toEqual([2]) // index 1 → item(2)
  })
})

describe('processAiRuleBatch — audit log written for every call', () => {
  it('a successful call records an ok audit row with real cost', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      usage: () => ({ inputTokens: 1000, outputTokens: 1000 }),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.auditRows).toHaveLength(1)
    expect(rec.auditRows[0].outcome).toBe('ok')
    expect(rec.auditRows[0].goal).toBe('rule')
    expect(rec.auditRows[0].untrustedWrapped).toBe(1)
    expect(rec.auditRows[0].costUsd).toBeGreaterThan(0)
  })

  it('a null provider result still records an error audit row', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => null,
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.auditRows).toHaveLength(1)
    expect(rec.auditRows[0].outcome).toBe('error')
    expect(rec.auditRows[0].costUsd).toBeNull()
  })
})

describe('processAiRuleBatch — partial provider usage (missing token fields)', () => {
  it('OpenAI-style: missing output → cost counts only reported input', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      usage: () => ({ inputTokens: 1000, outputTokens: 0 }),
      model: 'gpt-4o-mini',
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // input-only: 1000/1000 * 0.00015 = 0.00015
    expect(rec.auditRows[0].costUsd).toBeCloseTo(0.00015, 6)
  })

  it('missing input → cost counts only reported output', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      usage: () => ({ inputTokens: 0, outputTokens: 1000 }),
      model: 'gpt-4o-mini',
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // output-only: 1000/1000 * 0.0006 = 0.0006
    expect(rec.auditRows[0].costUsd).toBeCloseTo(0.0006, 6)
  })

  it('null usage on a SUCCESS persists the model-aware reservation (tokens stay null)', async () => {
    // A successful-but-unmetered call persists the budget reservation (not null),
    // so the next tick's `sumRuleCostSince` baseline includes it. Tokens stay
    // null (we truly have no counts) so the Privacy Panel still tells a metered
    // row from a reserved one.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      usage: () => null,
      model: 'gpt-4o-mini', // reservation floors to AI_RULE_NULL_USAGE_COST_FLOOR
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.auditRows[0].outcome).toBe('ok')
    expect(rec.auditRows[0].costUsd).toBe(AI_RULE_NULL_USAGE_COST_FLOOR)
    // Token columns remain null — the reservation is a cost, not a token count.
    expect(rec.auditRows[0].inputTokens).toBeNull()
    expect(rec.auditRows[0].outputTokens).toBeNull()
  })
})

describe('processAiRuleBatch — hourly rate limit', () => {
  it('increments once per model call, not once per batch', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })],
      respond: () => JSON.stringify([]),
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(3)
    expect(rate.callCount).toBe(3)
  })

  it('does not start an account whose full rule set exceeds the remaining hourly headroom', async () => {
    // Atomic-per-account: with only 1 call of headroom left but an account owing
    // 3 rules, the account is DEFERRED whole (no partial calls) and requeued.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'r0' }), rule({ id: 'r1' }), rule({ id: 'r2' })],
      respond: () => JSON.stringify([]),
    })
    // Pre-spend the hourly window down to 1 remaining call (window not elapsed).
    rate.callCount = AI_RULE_MAX_CALLS_PER_HOUR - 1
    rate.resetAt = 2_000 // now() default 1_000 → window live
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // 3 rules > 1 remaining call → the account never starts; no call made.
    expect(rec.chatCalls).toHaveLength(0)
    expect(rec.executed).toHaveLength(0)
    // Its item is requeued for a fresh window.
    expect(queue.map(q => q.uid)).toEqual([1])
  })
})

describe('processAiRuleBatch — daily budget (soft cap, atomic-per-account)', () => {
  it('valid enabled account is eventually admitted in a fresh daily window (tiny budget, no deadlock)', async () => {
    // Fix #1 regression guard: the OLD admission gate required
    // `budgetRemaining >= rules * worstCasePerCall` where worstCasePerCall was a
    // >= $0.05 reservation floor. A rule with budgetPerDayUsd below that floor
    // (here $0.01) could NEVER be admitted even in a totally fresh window — its
    // queue would deadlock forever. The soft-cap gate admits on ANY positive
    // budget headroom, so a valid tiny-budget rule runs, the model is called,
    // and the queue drains.
    const rules = [rule({ id: 'a', budgetPerDayUsd: 0.01 })]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      model: 'gpt-4o',
      usage: () => ({ inputTokens: 1000, outputTokens: 1000 }),
      spentToday: 0,
      respond: () => JSON.stringify([]),
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    // Positive budget in a fresh window → admitted: the model was called and the
    // queue drained (no permanent deferral / deadlock).
    expect(rec.chatCalls).toHaveLength(1)
    expect(queue).toHaveLength(0)
  })

  it('when spentToday already exceeds the daily cap, no call is made and the queue is PRESERVED', async () => {
    // Budget-exhausted must NOT clear the queue: the items (including any a
    // previous tick requeued) have to survive until the next daily window.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ budgetPerDayUsd: 0.5 })],
      spentToday: 1.0,
    })
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(0)
    // Both items are still queued — none were dropped.
    expect(queue.map(q => q.uid).sort()).toEqual([1, 2])
  })

  it('keeps budget-deferred items queued until the next daily window (no drop across ticks)', async () => {
    // Budget stays exhausted across two ticks; the items must survive both (a
    // buggy `queue.length = 0` would destroy them forever).
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ budgetPerDayUsd: 0.5 })],
      spentToday: 1.0,
    })
    queue.push(item(10), item(11), item(12))
    await processAiRuleBatch(deps, rate)
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(0)
    // Exact set preserved after both ticks — nothing lost to a queue wipe.
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  it('an account with enough budget for its whole rule set IS processed', async () => {
    // A generous budget lets the account start and run all its rules.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'a', budgetPerDayUsd: 5.0 }), rule({ id: 'b', budgetPerDayUsd: 5.0 })],
      respond: () => JSON.stringify([]),
      spentToday: 0,
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(2) // both rules ran
    expect(queue).toHaveLength(0) // account completed and drained
  })
})

describe('processAiRuleBatch — atomic-per-account', () => {
  it('an account either fully applies its decisions or is requeued whole — no partial apply', async () => {
    // One account, two rules over two items. Rule 0 archives index 0; rule 1
    // fails (null result). Because rule 1 fails, the account is INCOMPLETE →
    // NOTHING is applied for it (not even rule 0's archive), and the whole
    // account is requeued.
    const rules = [
      rule({ id: 'r0', accountId: '1', prompt: 'RULE_0' }),
      rule({ id: 'r1', accountId: '1', prompt: 'RULE_1' }),
    ]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respondFor: (userPrompt) =>
        userPrompt.startsWith('RULE_0\n')
          ? JSON.stringify([{ index: 0, action: 'archive' }])
          : null, // RULE_1 fails
    })
    queue.push(item(1, 1), item(2, 1))
    await processAiRuleBatch(deps, rate)
    // No partial apply: rule 0's archive was collected but NOT applied because
    // the account is incomplete.
    expect(rec.executed).toHaveLength(0)
    // The whole account is requeued — exact multiset.
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('an incomplete account (rejected parse) requeues whole then succeeds exactly once next tick', async () => {
    // Tick 1: rule 1 returns unparseable prose → account incomplete → requeued,
    // nothing applied. Tick 2: both rules succeed → rule 0's archive applies
    // exactly once (no double-apply from the tick-1 partial, no silent loss).
    const rules = [
      rule({ id: 'r0', accountId: '1', prompt: 'RULE_0' }),
      rule({ id: 'r1', accountId: '1', prompt: 'RULE_1' }),
    ]
    let rule1Calls = 0
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respondFor: (userPrompt) => {
        if (userPrompt.startsWith('RULE_0\n')) return JSON.stringify([{ index: 0, action: 'archive' }])
        rule1Calls++
        return rule1Calls === 1 ? 'not json at all' : JSON.stringify([])
      },
    })
    queue.push(item(1, 1))

    // Tick 1: incomplete → requeued, nothing applied.
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
    expect(queue.map(q => q.uid)).toEqual([1])

    // Tick 2: complete → archive applied exactly once.
    await processAiRuleBatch(deps, rate)
    expect(rec.executed.filter(e => e.action.type === 'archive')).toHaveLength(1)
    expect(queue).toHaveLength(0)
  })

  it('one account being incomplete does not block a sibling account from completing', async () => {
    // Account 1 (rule fails) is requeued whole; account 2 (rule succeeds) applies
    // its action and drains. Per-account isolation + atomicity: a failing account
    // never contaminates a healthy sibling.
    const rules = [
      rule({ id: 'a1', accountId: '1', prompt: 'ACC1' }),
      rule({ id: 'a2', accountId: '2', prompt: 'ACC2' }),
    ]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respondFor: (userPrompt) => {
        if (userPrompt.startsWith('ACC1\n')) return null // account 1 fails
        return JSON.stringify([{ index: 0, action: 'archive' }]) // account 2 ok
      },
    })
    queue.push(item(1, 1), item(2, 2))
    await processAiRuleBatch(deps, rate)
    // Account 2's item was archived and drained; account 1's item is requeued.
    expect(rec.executed.map(e => e.accountId)).toEqual([2])
    expect(queue.map(q => q.uid)).toEqual([1])
  })
})

describe('processAiRuleBatch — cross-account isolation & fairness', () => {
  it('processes multiple accounts, each call seeing exactly one account of mail', async () => {
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    // Each item's subject is `s${uid}` (see the `item` factory). Assign uids so
    // an account's subjects are unmistakably distinct from any sibling's.
    // Account 1: uids 11, 13 → subjects s11, s13. Account 2: uid 22 → s22.
    // Account 3: uid 34 → s34.
    queue.push(item(11, 1), item(22, 2), item(13, 1), item(34, 3))
    await processAiRuleBatch(deps, rate)
    // 3 accounts × 1 global rule → 3 calls. Every userPrompt block set belongs
    // to a single account (the pipeline groups by account before prompting).
    expect(rec.chatCalls.length).toBe(3)

    // Per-account isolation (CLAUDE.md §5): assert that EACH built userPrompt
    // contains the subjects of exactly ONE account and NEVER a sibling's — a
    // cross-account leak would let account A's rule read account B's mail. We map
    // each account to its own subject set and, per prompt, require it to match
    // one account's subjects while containing none of the others'.
    const accountSubjects: Record<number, string[]> = {
      1: ['s11', 's13'],
      2: ['s22'],
      3: ['s34'],
    }
    for (const call of rec.chatCalls) {
      // Which account does this prompt belong to? The one whose subjects it
      // contains. Exactly one account must match.
      const owning = Object.entries(accountSubjects).filter(([, subs]) =>
        subs.some(s => call.userPrompt.includes(`Subject: ${s}`)),
      )
      expect(owning).toHaveLength(1)
      const [owningAcct, ownSubjects] = owning[0]
      // Every one of the owning account's subjects is present.
      for (const s of ownSubjects) {
        expect(call.userPrompt).toContain(`Subject: ${s}`)
      }
      // And NO other account's subject leaked into this prompt.
      for (const [acct, subs] of Object.entries(accountSubjects)) {
        if (acct === owningAcct) continue
        for (const s of subs) {
          expect(call.userPrompt).not.toContain(`Subject: ${s}`)
        }
      }
    }
  })

  it('un-processed accounts are REQUEUED (not dropped) when headroom runs out mid-cycle', async () => {
    // Two accounts, one global rule each-effectively (a single global rule runs
    // once per account = 2 calls). Pre-spend the window so only ONE call of
    // headroom remains. The first account (1 rule) fits and completes; the
    // second account's admission check sees 0 headroom for its rule and defers
    // it whole → requeued.
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    rate.callCount = AI_RULE_MAX_CALLS_PER_HOUR - 1
    rate.resetAt = 2_000 // window live
    queue.push(item(1, 1), item(2, 2))
    await processAiRuleBatch(deps, rate)
    // Exactly one call fired (the first account); the second was deferred.
    expect(rec.chatCalls).toHaveLength(1)
    // The unprocessed account's item is requeued.
    expect(queue.map(q => q.uid)).toContain(2)
  })
})

describe('processAiRuleBatch — dedup (one action per email)', () => {
  it('conflicting rules on the same email apply at most one action (first rule wins)', async () => {
    let call = 0
    const rules = [rule({ id: 'high', prompt: 'HIGH' }), rule({ id: 'low', prompt: 'LOW' })]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respond: () => {
        // Call order = rule order (high then low) for the single account.
        call++
        return call === 1
          ? JSON.stringify([{ index: 0, action: 'move', folder: 'Archive' }])
          : JSON.stringify([{ index: 0, action: 'mark_read' }])
      },
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('move')
  })
})

describe('processAiRuleBatch — no enabled rules', () => {
  let s: { deps: AiRulesPipelineDeps; rate: AiRuleRateLimitState; rec: Recorded; queue: AiRulePendingItem[] }
  beforeEach(() => {
    s = makeHarness({ rules: [rule({ enabled: false })] })
    s.queue.push(item(1))
  })
  it('clears the queue and makes no call when all rules are disabled', async () => {
    await processAiRuleBatch(s.deps, s.rate)
    expect(s.rec.chatCalls).toHaveLength(0)
    expect(s.queue).toHaveLength(0)
  })
})

describe('processAiRuleBatch — batch size cap', () => {
  it('dequeues at most AI_RULE_BATCH_SIZE items, leaving the rest queued', async () => {
    const { deps, rate, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    for (let i = 0; i < AI_RULE_BATCH_SIZE + 3; i++) queue.push(item(i))
    await processAiRuleBatch(deps, rate)
    // 3 items remain queued for the next cycle (all same account → one call).
    expect(queue.length).toBe(3)
  })
})

describe('processAiRuleBatch — single-flight (concurrent tick serialization)', () => {
  it('serializes overlapping batch ticks within the daily budget', async () => {
    // Hold the FIRST batch open on its model call, then fire a SECOND tick while
    // the first is still awaiting. The single-flight latch must make the second
    // an immediate no-op so it neither re-reads spentToday nor fires extra calls.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let firstChatEntered = false
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      beforeChat: async () => {
        if (!firstChatEntered) {
          firstChatEntered = true
          await gate // hold the first call open
        }
      },
    })
    queue.push(item(1))

    const firstRun = processAiRuleBatch(deps, rate) // enters, awaits the gate
    // Spin until the first run has actually entered the chat call.
    for (let i = 0; i < 50 && !firstChatEntered; i++) await Promise.resolve()
    expect(firstChatEntered).toBe(true)
    expect(rate.inFlight).toBe(true)

    // Second tick overlaps the in-flight first run — must be a no-op.
    queue.push(item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1)
    expect(queue.map(q => q.uid)).toContain(2)

    release()
    await firstRun
    // Latch released after the first run finished.
    expect(rate.inFlight).toBe(false)
    expect(rec.chatCalls).toHaveLength(1)
  })

  it('a fresh state releases the latch even when the batch throws', async () => {
    // getMailboxCache throws → the batch bails, but `finally` must still clear
    // inFlight so the NEXT tick is not permanently blocked.
    const { deps, rate, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      getMailboxCache: () => { throw new Error('cache boom') },
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rate.inFlight).toBe(false)
  })
})

describe('processAiRuleBatch — usage:null fail-closed budget (in-batch, no bypass)', () => {
  it('null-usage is charged the reservation so budget still accrues within a batch', async () => {
    // A provider that reports no usage still advances the in-batch running spend
    // by the model-aware reservation, so accumulatedCost is not $0. We confirm
    // the reservation is what gets charged.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'a', budgetPerDayUsd: 5.0 })],
      respond: () => JSON.stringify([]),
      usage: () => null,
      model: 'gpt-4o-mini',
      spentToday: 0,
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.auditRows[0].costUsd).toBe(AI_RULE_NULL_USAGE_COST_FLOOR)
  })

  it('a tiny-budget account with positive headroom IS admitted and charges the reservation (soft cap, bounded overshoot)', async () => {
    // Fix #1: the daily budget is a SOFT cap. A tiny budget ($0.01) still has
    // positive headroom in a fresh window, so the account is admitted and runs
    // its whole rule set. A single unmetered call is charged the model-aware
    // reservation ($0.05). The overshoot is bounded (one account's rule set),
    // and the HARD hourly call cap bounds total spend — no deadlock, no bypass.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'a', budgetPerDayUsd: 0.01 })], // < one reservation (0.05) but > 0
      respond: () => JSON.stringify([]),
      usage: () => null,
      model: 'gpt-4o-mini',
      spentToday: 0,
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // Admitted: one call made, queue drained, reservation charged.
    expect(rec.chatCalls).toHaveLength(1)
    expect(queue).toHaveLength(0)
    expect(rec.auditRows[0].costUsd).toBe(AI_RULE_NULL_USAGE_COST_FLOOR)
  })

  it('stops admitting sibling accounts after one tiny-budget account overshoots', async () => {
    // Two accounts sharing one global rule, budget $0.01 — below one reservation
    // ($0.05). Account 1 (processed first: fresh rotation + Map insertion order)
    // is admitted on positive headroom and overshoots the budget by its single
    // reservation. Account 2 must then be DEFERRED by the now-exhausted soft
    // budget gate — NOT admitted a second time. This proves the overshoot is
    // bounded to exactly one account's rule set, not unbounded across siblings.
    const rules = [rule({ id: 'a', accountId: null, budgetPerDayUsd: 0.01 })]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respond: () => JSON.stringify([]),
      usage: () => null,
      model: 'gpt-4o-mini',
      dynamicSpend: true, // budgetRemaining must see account 1's persisted spend
      spentToday: 0,
    })
    const firstUid = 1
    const secondUid = 2
    queue.push(item(firstUid, 1), item(secondUid, 2))
    await processAiRuleBatch(deps, rate)

    // Exactly ONE model call — account 1 ran, account 2 was never started.
    expect(rec.chatCalls).toHaveLength(1)
    // The exact deferred queue — account 2's item only, no duplication.
    expect(queue.map(q => q.uid)).toEqual([secondUid])
  })
})

describe('processAiRuleBatch — no silent loss (exact multiset preservation)', () => {
  it('requeues the exact dequeued batch when mailbox cache lookup throws', async () => {
    // getMailboxCache throws AFTER the splice → the outer catch fires, and the
    // finally must requeue every dequeued item (none silently lost).
    const { deps, rate, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      getMailboxCache: () => { throw new Error('mailbox cache boom') },
    })
    const uids = [7, 8, 9]
    for (const u of uids) queue.push(item(u, 1))
    await processAiRuleBatch(deps, rate)
    // Every dequeued item is back in the queue — the exact multiset.
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual(uids)
  })

  it('a completed account is NOT requeued (its items are triaged)', async () => {
    const { deps, rate, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(queue).toHaveLength(0)
  })
})

describe('processAiRuleBatch — no starvation (account rotation)', () => {
  it('a deferred account rotates ahead next cycle and gets processed', async () => {
    // Two single-rule-per-account accounts. Pre-spend the window so only ONE call
    // of headroom remains: cycle 1 processes the leading account (rotation 0),
    // defers the trailing one, and requeues it. Cycle 2 (fresh window + advanced
    // rotation) leads with the other account, so BOTH eventually complete.
    const rules = [
      rule({ id: 'a1', accountId: '1', prompt: 'ACC1' }),
      rule({ id: 'a2', accountId: '2', prompt: 'ACC2' }),
    ]
    const { deps, rate, rec, queue } = makeHarness({ rules, respond: () => JSON.stringify([]) })
    rate.callCount = AI_RULE_MAX_CALLS_PER_HOUR - 1
    rate.resetAt = 2_000 // window live so only 1 call of headroom
    queue.push(item(1, 1), item(2, 2))

    // Cycle 1: one account processed, the other deferred and requeued.
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1)
    const remainingAfter1 = queue.map(q => q.uid)
    expect(remainingAfter1.length).toBe(1)

    // Cycle 2: fresh window; the previously-deferred account leads and completes.
    rate.callCount = 0
    rate.resetAt = 0
    await processAiRuleBatch(deps, rate)
    expect(queue).toHaveLength(0) // both accounts eventually drained
    // Both account prompts were seen across the two cycles — neither starved.
    expect(rec.chatCalls.some(c => c.userPrompt.startsWith('ACC1'))).toBe(true)
    expect(rec.chatCalls.some(c => c.userPrompt.startsWith('ACC2'))).toBe(true)
  })

  it('rotation advances the cursor every cycle', async () => {
    const { deps, rate, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    queue.push(item(1, 1))
    const before = rate.accountRotation
    await processAiRuleBatch(deps, rate)
    expect(rate.accountRotation).toBe(before + 1)
  })
})

describe('processAiRuleBatch — early-return branches', () => {
  it('isShuttingDown short-circuits with no dequeue and no calls', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      isShuttingDown: () => true,
    })
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(0)
    // Queue untouched — nothing dequeued during shutdown.
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([1, 2])
    expect(rate.inFlight).toBe(false)
  })

  it('initial hourly-cap return leaves the queue intact and makes no call', async () => {
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    // Pre-load the rate state at the cap with a live (non-elapsed) window.
    rate.callCount = AI_RULE_MAX_CALLS_PER_HOUR
    rate.resetAt = 2_000 // now() default is 1_000 → window has NOT elapsed
    queue.push(item(1), item(2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(0)
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('a mid-batch window reset lets calls resume after the hour rolls', async () => {
    // callCount starts AT the cap but the window has elapsed (now > resetAt), so
    // the initial reset zeroes it and the batch proceeds normally.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
      now: () => 10_000,
    })
    rate.callCount = AI_RULE_MAX_CALLS_PER_HOUR
    rate.resetAt = 5_000 // now (10_000) > resetAt → window elapsed → reset
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1)
    expect(rate.callCount).toBe(1)
  })

  it('a failed executor apply requeues that item for retry (transient IMAP fault)', async () => {
    // A transient apply failure (IMAP down) must NOT terminally lose the item —
    // it is requeued so the next cycle re-classifies it from scratch. Successful
    // items already left the queue, so there is no double-apply risk.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'archive' }]),
      onExecute: () => { throw new Error('imap down') },
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // The executor was attempted once and threw; the item is requeued exactly
    // once for a later retry (not silently lost, not duplicated).
    expect(rec.executed).toHaveLength(1)
    expect(queue.map(q => q.uid)).toEqual([1])
  })
})

describe('processAiRuleBatch — soft daily budget across ticks (audit-persisted)', () => {
  it('admits on tick 1, charges the reservation, then defers tick 2 once the persisted spend exhausts the budget', async () => {
    // Soft-cap accrual across ticks (fix #1). Tick 1: the budget ($0.04) has
    // positive headroom → the account is ADMITTED, makes one unmetered call, and
    // persists the model-aware reservation ($0.05) to the audit log. Tick 2:
    // `sumRuleCostSince` now reads that persisted $0.05, which >= the $0.04 cap →
    // budget exhausted → the next account is DEFERRED (soft cap stops STARTING
    // new accounts once spent). The reservation persistence is what makes the
    // budget bind across ticks despite the provider never reporting usage.
    const rules = [rule({ id: 'a', budgetPerDayUsd: 0.04 })] // < one reservation (0.05)
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respond: () => JSON.stringify([]),
      usage: () => null,
      model: 'gpt-4o-mini', // reservation floors to 0.05
      dynamicSpend: true, // sumRuleCostSince reflects persisted audit rows
      spentToday: 0,
    })

    // Tick 1: positive budget → admitted; one call, reservation charged, drained.
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1)
    expect(queue).toHaveLength(0)
    expect(rec.auditRows[0].costUsd).toBe(AI_RULE_NULL_USAGE_COST_FLOOR)

    // Tick 2: a fresh account, but the persisted $0.05 already exhausts the $0.04
    // cap (preflight `spentToday >= maxBudget`) → no call, item requeued.
    queue.push(item(2, 2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1) // still just tick 1's call
    // The exact deferred queue — tick 2's item only, no duplication.
    expect(queue.map(q => q.uid)).toEqual([2])
  })

  it('a metered account accrues spend that binds the budget on the next tick', async () => {
    // A generous-enough budget admits the first account (positive headroom). Its
    // metered spend (~0.02 for gpt-4o at 1000/1000 tokens) persists; on the next
    // tick that persisted spend leaves NO positive headroom, so the second
    // account is deferred by the soft budget gate.
    const rules = [rule({ id: 'a', budgetPerDayUsd: 0.02 })]
    const { deps, rate, rec, queue } = makeHarness({
      rules,
      respond: () => JSON.stringify([]),
      usage: () => ({ inputTokens: 1000, outputTokens: 1000 }),
      model: 'gpt-4o', // 1000/1000 tokens → 0.005 + 0.015 = 0.02 metered
      dynamicSpend: true,
      spentToday: 0,
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1) // first account admitted (0.02 budget > 0) and completed
    expect(queue).toHaveLength(0)

    // Tick 2: a fresh account. The ~0.02 metered spend already persisted meets
    // the 0.02 cap (spentToday >= maxBudget) → budget exhausted → deferred.
    queue.push(item(2, 2))
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls).toHaveLength(1) // no new call
    // The exact deferred queue — tick 2's item only, no duplication.
    expect(queue.map(q => q.uid)).toEqual([2])
  })
})

describe('processAiRuleBatch — malformed / non-finite provider usage', () => {
  it('malformed usage falls back to the null-usage reservation (no NaN in the ledger)', async () => {
    // A provider returning NaN/Infinity token counts must NOT poison the running
    // budget: estimateAiRuleCostUsd rejects non-finite usage → the pipeline
    // charges the model-aware reservation instead of a NaN.
    const { deps, rate, rec, queue } = makeHarness({
      rules: [rule({ id: 'a', budgetPerDayUsd: 5.0 })],
      respond: () => JSON.stringify([]),
      usage: () => ({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }),
      model: 'gpt-4o-mini',
      spentToday: 0,
    })
    queue.push(item(1))
    await processAiRuleBatch(deps, rate)
    // The ledger holds a finite reservation, never NaN.
    for (const row of rec.auditRows) {
      if (row.costUsd !== null) {
        expect(Number.isFinite(row.costUsd)).toBe(true)
      }
    }
    expect(rec.auditRows[0].costUsd).toBe(AI_RULE_NULL_USAGE_COST_FLOOR)
  })
})

describe('processAiRuleBatch — failed apply requeues only the failed item', () => {
  it('requeues only the failed-apply item without replaying successes', async () => {
    // One complete account, two items, both get an archive decision. The executor
    // fails ONLY for uid=1 and succeeds for uid=2. uid=1 must be requeued (retry)
    // exactly once; uid=2 must NOT be requeued (no replay of a successful apply).
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([
        { index: 0, action: 'archive' },
        { index: 1, action: 'archive' },
      ]),
      onExecute: ({ uid }) => { if (uid === 1) throw new Error('imap flake for uid=1') },
    })
    queue.push(item(1, 1), item(2, 1))
    await processAiRuleBatch(deps, rate)

    // Both applies were attempted.
    expect(rec.executed.map(e => e.uid).sort((a, b) => a - b)).toEqual([1, 2])
    // Only the FAILED uid=1 is requeued, exactly once; the SUCCESSFUL uid=2 is
    // not replayed.
    expect(queue.map(q => q.uid)).toEqual([1])
    // uid=2's successful apply was logged; uid=1's failed apply wrote no apply
    // log row (it threw before the log insert).
    const loggedUids = rec.ruleLog.map(r => r.uid)
    expect(loggedUids).toContain(2)
    expect(loggedUids).not.toContain(1)
  })
})

describe('processAiRuleBatch — successful apply is final even if the log write fails', () => {
  it('does not double-apply when the execution-log INSERT throws after a successful apply', async () => {
    // The reversible executor SUCCEEDS, but the execution-log INSERT throws. The
    // item must be settled FINAL right after the apply — the log failure is
    // best-effort and must NOT requeue the item (which would apply the action a
    // SECOND time on the next tick).
    let logCalls = 0
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'archive' }]),
    })
    // insertAiRuleLog (the apply log) throws; count how many times it runs.
    deps.insertAiRuleLog = () => {
      logCalls++
      throw new Error('execution-log INSERT failed')
    }
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)

    // The apply ran exactly once.
    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('archive')
    // The item was settled FINAL despite the log throw → NOT requeued.
    expect(queue).toHaveLength(0)

    // A second tick has nothing to do — the item is not replayed.
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(1) // still just the one apply — no double-apply
    // The apply log was attempted once (it threw); it was not retried.
    expect(logCalls).toBe(1)
  })

  it('does not requeue an item when post-apply telemetry throws', async () => {
    // Fix #2: the item is settled FINAL the instant the mailbox commit succeeds,
    // BEFORE any best-effort post-apply work. If recordEvent throws AFTER a
    // successful executor, that throw must be contained (best-effort) and must
    // NOT un-settle the item — otherwise the finally-block requeue would replay
    // the already-applied action on the next tick (double-apply).
    let recordCalls = 0
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'archive' }]),
    })
    // recordEvent throws on the ai.rule.applied event (fired right after apply).
    deps.recordEvent = (name) => {
      recordCalls++
      if (name === 'ai.rule.applied') throw new Error('telemetry sink down')
    }
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)

    // The apply ran exactly once and the item settled despite the telemetry throw.
    expect(rec.executed).toHaveLength(1)
    expect(rec.executed[0].action.type).toBe('archive')
    expect(queue).toHaveLength(0)
    expect(recordCalls).toBeGreaterThan(0) // the throwing recordEvent WAS reached

    // Second tick: nothing to replay — exactly ONE execute for the item.
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(1) // still one — no double-apply
  })

  it('keeps earlier applied item final when a later preview insert throws', async () => {
    // Fix #2, multi-item within the SAME account: item 1 resolves to a
    // reversible action (applied + settled final FIRST), item 2 resolves to a
    // destructive action whose preview-log insert throws. The throw on item 2
    // must not reach back and un-settle item 1 — the finally-block requeue only
    // sees whatever is still in `untriaged`, which must be item 2 alone. A
    // second tick must NOT replay item 1's apply (no double-apply).
    const insertCallsByUid: number[] = []
    const { deps, rate, rec, queue } = makeHarness({
      // Keyed on call index (not batch position) so tick 2 — which re-sends
      // ONLY item 2 in a fresh sub-batch of size 1 — still resolves item 2 to
      // `trash`, not whatever the first response happened to be at index 0.
      respondFor: (_userPrompt, callIndex) =>
        callIndex === 0
          ? JSON.stringify([
              { index: 0, action: 'archive' },
              { index: 1, action: 'trash' },
            ])
          : JSON.stringify([{ index: 0, action: 'trash' }]),
    })
    deps.insertAiRuleLog = (data) => {
      insertCallsByUid.push(data.uid)
      if (data.uid === 2) throw new Error('preview-log INSERT failed for uid=2')
      rec.ruleLog.push({ aiRuleId: data.aiRuleId, accountId: data.accountId, uid: data.uid, actionTaken: data.actionTaken })
    }
    const firstUid = 1
    const secondUid = 2
    queue.push(item(firstUid, 1), item(secondUid, 1))
    await processAiRuleBatch(deps, rate)

    // Item 1's reversible action was applied exactly once.
    expect(rec.executed.map(e => e.uid)).toEqual([firstUid])
    // Item 2's preview insert threw → it is requeued (retry), item 1 is not.
    expect(queue.map(q => q.uid)).toEqual([secondUid])
    // insertAiRuleLog ran once per item this tick (item 1's execution-log write
    // succeeded, item 2's preview-log write threw) — no duplicate insert for
    // either uid, and none was skipped.
    expect(insertCallsByUid.sort((a, b) => a - b)).toEqual([firstUid, secondUid])

    // A second tick reclassifies item 2 from scratch; item 1 is NEVER replayed.
    await processAiRuleBatch(deps, rate)
    expect(rec.executed.map(e => e.uid)).toEqual([firstUid]) // still exactly once
  })

  it('does not requeue a destructive-preview item when post-preview telemetry throws', async () => {
    // Fix #2 (preview path): a destructive preview is recorded, then the item is
    // settled final BEFORE the best-effort telemetry. A throw from recordEvent
    // must not un-settle it (which would re-record the preview next tick).
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([{ index: 0, action: 'trash' }]),
    })
    deps.recordEvent = (name) => {
      if (name === 'ai.rule.destructive_preview') throw new Error('telemetry sink down')
    }
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)

    // The preview was recorded once; the executor was never called (destructive).
    expect(rec.executed).toHaveLength(0)
    expect(rec.ruleLog.filter(r => r.actionTaken.includes('preview_pending'))).toHaveLength(1)
    // The item settled despite the telemetry throw — not requeued.
    expect(queue).toHaveLength(0)

    // Second tick: no replay of the preview.
    await processAiRuleBatch(deps, rate)
    expect(rec.ruleLog.filter(r => r.actionTaken.includes('preview_pending'))).toHaveLength(1)
  })
})

describe('processAiRuleBatch — transient classification failure is not a no-op', () => {
  it('a null provider result requeues the account (uncharged, not silently dropped)', async () => {
    // A null provider result is a TRANSIENT failure, not a confirmed "no action".
    // The account must be requeued (retry), the audit row must record an error
    // with NULL cost, and the exact queue multiset must be preserved.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => null, // provider error on every call
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)

    // No action applied (classification failed).
    expect(rec.executed).toHaveLength(0)
    // The error audit row carries a null cost (nothing billable).
    expect(rec.auditRows).toHaveLength(1)
    expect(rec.auditRows[0].outcome).toBe('error')
    expect(rec.auditRows[0].costUsd).toBeNull()
    // The item is requeued for retry — NOT settled as a false no-op.
    expect(queue.map(q => q.uid)).toEqual([1])
  })

  it('a rejected parse (prose response) requeues the account for retry, not a no-op', async () => {
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => 'Sure, here you go: not-json-at-all',
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
    // Requeued (transient parse failure), not dropped.
    expect(queue.map(q => q.uid)).toEqual([1])
  })

  it('a CONFIRMED empty decision set IS a settled no-op (account drains, not requeued)', async () => {
    // Control: the model SUCCESSFULLY responds with an empty array (a genuine "no
    // action"). That is a confirmed no-op — the account settles and NOT requeued.
    const { deps, rate, rec, queue } = makeHarness({
      respond: () => JSON.stringify([]),
    })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    expect(rec.executed).toHaveLength(0)
    expect(queue).toHaveLength(0) // confirmed no-op → dropped
  })
})

describe('processAiRuleBatch — preflight dependency errors', () => {
  it('contains preflight dependency errors without latching or dequeueing', async () => {
    // listAiRules throws in the PRE-latch preflight. The promise must resolve
    // (no unhandled rejection out of the timer), the queue must be untouched,
    // and inFlight must be false so the next healthy tick runs normally.
    let boom = true
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    deps.listAiRules = () => {
      if (boom) throw new Error('DB read failed in preflight')
      return [rule()]
    }
    queue.push(item(1), item(2))

    // Poisoned tick: resolves cleanly, dequeues nothing, does not latch.
    await expect(processAiRuleBatch(deps, rate)).resolves.toBeUndefined()
    expect(rec.chatCalls).toHaveLength(0)
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([1, 2])
    expect(rate.inFlight).toBe(false)

    // Next healthy tick proceeds normally on the preserved queue.
    boom = false
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls.length).toBeGreaterThan(0)
    expect(rate.inFlight).toBe(false)
  })

  it('contains a sumRuleCostSince preflight error the same way', async () => {
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    deps.sumRuleCostSince = () => { throw new Error('budget read failed') }
    queue.push(item(1))
    await expect(processAiRuleBatch(deps, rate)).resolves.toBeUndefined()
    expect(rec.chatCalls).toHaveLength(0)
    expect(queue.map(q => q.uid)).toEqual([1]) // queue preserved
    expect(rate.inFlight).toBe(false)
  })

  it('a throw from now() before the latch resolves cleanly without dequeue or latch', async () => {
    const { deps, rate, rec, queue } = makeHarness({ respond: () => JSON.stringify([]) })
    let boom = true
    deps.now = () => {
      if (boom) throw new Error('clock boom in preflight')
      return 1_000
    }
    queue.push(item(1), item(2))
    await expect(processAiRuleBatch(deps, rate)).resolves.toBeUndefined()
    expect(rec.chatCalls).toHaveLength(0)
    expect(queue.map(q => q.uid).sort((a, b) => a - b)).toEqual([1, 2]) // untouched
    expect(rate.inFlight).toBe(false)

    boom = false
    await processAiRuleBatch(deps, rate)
    expect(rec.chatCalls.length).toBeGreaterThan(0)
    expect(rate.inFlight).toBe(false)
  })
})

describe('processAiRuleBatch — bounded requeue under a full queue', () => {
  it('requeue during a full queue preserves the hard cap (drop-newest-arrival)', async () => {
    // Hold the model call open, and WHILE the batch is in flight fill the queue
    // to the cap. When the batch requeues its un-triaged remainder it must merge
    // under the hard AI_RULE_QUEUE_MAX cap, never exceeding it, dropping from the
    // TAIL (the newest arrivals) so the requeued in-flight cohort at the front is
    // protected.
    //
    // To guarantee a requeue we make the single account's rule FAIL (null result)
    // so the account is incomplete and its items are requeued whole.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let firstChatEntered = false
    const { deps, rate, queue } = makeHarness({
      rules: [rule({ id: 'r0', accountId: '1' })],
      respond: () => null, // fail → account incomplete → requeued
      beforeChat: async () => {
        if (!firstChatEntered) {
          firstChatEntered = true
          await gate // hold the call open so we can fill the queue
        }
      },
    })
    queue.push(item(1, 1), item(2, 1))

    const run = processAiRuleBatch(deps, rate)
    for (let i = 0; i < 50 && !firstChatEntered; i++) await Promise.resolve()
    expect(firstChatEntered).toBe(true)

    // Fill the REMAINING queue to the hard cap while the batch is in flight.
    while (queue.length < AI_RULE_QUEUE_MAX) queue.push(item(1000 + queue.length, 1))
    expect(queue.length).toBe(AI_RULE_QUEUE_MAX)

    release()
    await run

    // The requeue merged the un-triaged remainder under the hard cap.
    expect(queue.length).toBeLessThanOrEqual(AI_RULE_QUEUE_MAX)
    // Drop-newest-arrival: the freshly-requeued in-flight cohort (front) survived.
    expect(queue.map(q => q.uid)).toContain(1)
    expect(queue.map(q => q.uid)).toContain(2)
  })
})

describe('processAiRuleBatch — config cap keeps atomic-per-account terminating', () => {
  it('the per-account enabled cap is <= the hourly call cap (a full account fits one window)', () => {
    // This relationship is the invariant that makes the atomic model terminate:
    // an account's whole applicable rule set always fits inside a fresh hourly
    // window, so it can never be permanently deferred for lack of call headroom.
    expect(AI_RULE_MAX_ENABLED_PER_ACCOUNT).toBeLessThanOrEqual(AI_RULE_MAX_CALLS_PER_HOUR)
  })

  it('an account with a full (cap-sized) rule set completes in a single fresh-window tick', async () => {
    // A single account with exactly AI_RULE_MAX_ENABLED_PER_ACCOUNT rules — the
    // maximum a valid config can enable — runs all its rules and drains in one
    // tick on a fresh window. Proves the config cap guarantees completion.
    const rules = Array.from({ length: AI_RULE_MAX_ENABLED_PER_ACCOUNT }, (_, i) =>
      rule({ id: `r${i}`, accountId: '1', prompt: `RULE_${i}` }),
    )
    const { deps, rate, rec, queue } = makeHarness({ rules, respond: () => JSON.stringify([]) })
    queue.push(item(1, 1))
    await processAiRuleBatch(deps, rate)
    // Every rule ran once and the account drained.
    expect(rec.chatCalls).toHaveLength(AI_RULE_MAX_ENABLED_PER_ACCOUNT)
    expect(queue).toHaveLength(0)
  })

  it('legacy over-cap account is deferred without crashing and does not starve a valid sibling', async () => {
    // Defence-in-depth: the config cap normally prevents an account from having
    // MORE applicable rules than the hourly call cap, but a legacy DB (created
    // before the cap) or a lowered cap could produce one. Such an account can
    // NEVER be call-atomically admitted (its rule set exceeds a whole fresh
    // window), so it is deferred every tick. The pipeline must (a) not crash on
    // it, and (b) not let it starve a healthy sibling account — account rotation
    // must eventually put the valid sibling first so it processes.
    const overCap = AI_RULE_MAX_CALLS_PER_HOUR + 1
    const legacyRules = Array.from({ length: overCap }, (_, i) =>
      rule({ id: `legacy${i}`, accountId: '1', prompt: `LEGACY_${i}` }),
    )
    const siblingRule = rule({ id: 'sib', accountId: '2', prompt: 'SIBLING' })
    const { deps, rate, rec, queue } = makeHarness({
      rules: [...legacyRules, siblingRule],
      respond: () => JSON.stringify([]),
    })
    // Keep BOTH accounts in the queue across ticks — the over-cap account is
    // always requeued, the sibling must eventually be reached via rotation.
    queue.push(item(1, 1), item(2, 2))

    // Run several ticks with a fresh window each time (reset the hourly window so
    // call headroom is never the limiter for the sibling). The over-cap account
    // is deferred every tick; rotation must surface the sibling.
    let sawSibling = false
    for (let t = 0; t < 5 && !sawSibling; t++) {
      rate.callCount = 0
      rate.resetAt = 0
      await processAiRuleBatch(deps, rate)
      sawSibling = rec.chatCalls.some(c => c.userPrompt.startsWith('SIBLING'))
    }

    // The sibling account was processed (its item drained) — it did NOT starve
    // behind the perpetually-deferred over-cap account. No crash occurred.
    expect(sawSibling).toBe(true)
    // The exact deferred queue — the over-cap account's item only, no
    // duplication and the drained sibling item is gone.
    expect(queue.map(q => q.uid)).toEqual([1])
  })
})
