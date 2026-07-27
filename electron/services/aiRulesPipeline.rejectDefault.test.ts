import { describe, it, expect, vi } from 'vitest'
import type {
  AiRulesPipelineDeps,
  AiRulePipelineRule,
  AiRuleRateLimitState,
} from './aiRulesPipeline'
import type { AiRulePendingItem, RuleAction } from '../../packages/core'

// ── Reject-by-default reversibility guard — genuine branch execution ────────
//
// The production action set is a CLOSED enum whose every member is classified
// as either reversible or destructive, so under normal parsing the
// `!isReversibleAiRuleAction(...)` guard in processAiRuleBatch is unreachable:
// a destructive verb is caught by the destructive branch first, and every other
// admitted verb is reversible. That guard is DEFENSE IN DEPTH for a future
// action added to the parser/enum but NOT yet classified.
//
// To prove the guard actually rejects such an action (and does not silently
// auto-apply it), we mock ONLY `parseAiRuleResponse` to emit a synthetic,
// unclassified action while keeping the REAL `isReversibleAiRuleAction` and
// `isDestructiveAiRuleAction` classifiers. The pipeline must then take the
// reject branch and never call the executor.

vi.mock('../../packages/core', async (importActual) => {
  const actual = await importActual<typeof import('../../packages/core')>()
  return {
    ...actual,
    parseAiRuleResponse: () => ({
      ok: true as const,
      // 'quarantine' is NOT in the reversible set, NOT in the destructive set,
      // and NOT a real RuleActionType — exactly the "future unclassified verb"
      // the guard exists to reject. Cast through unknown because it is
      // deliberately outside the closed enum.
      decisions: [
        { index: 0, action: 'quarantine' as unknown as RuleAction['type'] },
      ],
    }),
    // validateDecisionFolder must pass the synthetic decision straight through
    // (non-move actions are untouched by the real impl, but we are inside the
    // mock so re-provide the real behaviour for our synthetic action).
    validateDecisionFolder: (d: unknown) => d,
  }
})

// Imported AFTER the mock is registered so the pipeline binds the mocked core.
const { processAiRuleBatch, createRateLimitState } = await import('./aiRulesPipeline')

function rule(overrides: Partial<AiRulePipelineRule> = {}): AiRulePipelineRule {
  return {
    id: 'r1',
    accountId: null,
    enabled: true,
    prompt: 'classify',
    allowedActions: JSON.stringify(['archive', 'move', 'mark_read', 'mark_starred']),
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

function makeDeps(queue: AiRulePendingItem[]): {
  deps: AiRulesPipelineDeps
  rate: AiRuleRateLimitState
  executed: RuleAction[]
  ruleLog: string[]
  events: string[]
} {
  const executed: RuleAction[] = []
  const ruleLog: string[] = []
  const events: string[] = []
  const deps: AiRulesPipelineDeps = {
    queue,
    isShuttingDown: () => false,
    listAiRules: () => [rule()],
    sumRuleCostSince: () => 0,
    getMailboxCache: () => ({ 1: [{ path: 'INBOX' }] }),
    aiChatSimple: async () => ({ text: '[]', model: 'gpt-4o-mini', usage: { inputTokens: 10, outputTokens: 10 } }),
    executeRuleAction: async (_a, _f, _u, action) => { executed.push(action) },
    insertAiRuleLog: (d) => { ruleLog.push(d.actionTaken) },
    appendAiActionLog: () => true,
    getProviderModel: () => ({ provider: 'openai-api', model: 'gpt-4o-mini' }),
    recordEvent: (name) => { events.push(name) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => 1_000,
  }
  return { deps, rate: createRateLimitState(), executed, ruleLog, events }
}

describe('processAiRuleBatch — reject-by-default reversibility guard (branch executed)', () => {
  it('an unclassified action (neither reversible nor destructive) is NEVER executed', async () => {
    const queue: AiRulePendingItem[] = [item(1)]
    const { deps, rate, executed, ruleLog, events } = makeDeps(queue)
    await processAiRuleBatch(deps, rate)
    // The synthetic 'quarantine' action is not reversible and not destructive →
    // the reject-by-default guard drops it. The real executor is never called,
    // no apply log is written, and no applied/preview event is emitted.
    expect(executed).toHaveLength(0)
    expect(ruleLog).toHaveLength(0)
    expect(events).not.toContain('ai.rule.applied')
    expect(events).not.toContain('ai.rule.destructive_preview')
  })
})
