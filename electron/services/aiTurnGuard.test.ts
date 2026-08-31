/**
 * Tests for the §2.123 per-turn honesty guard.
 *
 * The three acceptance cases the guard exists for are stated as their own
 * tests, in the language of the incident:
 *   (a) a turn that armed an action → silent (no notice);
 *   (b) a turn that reached for destructive tools and armed nothing → detected;
 *   (c) a read-only turn → silent.
 *
 * Everything else here defends the two properties that make the detector
 * trustworthy: it reads TURN STATE (tool names, registry contents) and never
 * text, and it never restricts a productive search.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture telemetry without booting the metrics pipeline.
const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({
  recordEvent: recordEventMock,
}))

// electron-log is noisy (and irrelevant) under vitest.
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  SEARCH_EMAILS_ACCOUNT_LIMIT,
  SEARCH_EMAILS_EMPTY_BUDGET,
  SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT,
  classifyDestructiveTool,
  createTurnGuard,
  currentTurnGuard,
  recordTurnGuardMismatch,
  runWithTurnGuard,
  type AiTurnGuard,
} from './aiTurnGuard'

/**
 * Guard over an empty registry, which is the common case in these tests.
 *
 * Deliberately injects NO configured-account accessor: that is the degraded
 * path (the account list is unknown), where the guard keeps the fixed ceiling.
 * Tests that care about configured vs invented ids use `guardWithAccounts`.
 */
function guardWithRegistry(ids: string[] = []): { guard: AiTurnGuard; registry: string[] } {
  const registry = [...ids]
  const guard = createTurnGuard({ requestId: 'req-1', listPreviewIds: () => [...registry] })
  return { guard, registry }
}

/** Guard that knows exactly which accounts the user has configured. */
function guardWithAccounts(listConfiguredAccountIds: () => number[]): AiTurnGuard {
  return createTurnGuard({
    requestId: 'req-accounts',
    listPreviewIds: () => [],
    listConfiguredAccountIds,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('classifyDestructiveTool', () => {
  it('recognises both halves of a pair, prefixed and bare', () => {
    expect(classifyDestructiveTool('preview_mail_action')).toBe('preview')
    expect(classifyDestructiveTool('mcp__mailcopilot__preview_mail_action')).toBe('preview')
    expect(classifyDestructiveTool('apply_mail_action')).toBe('apply')
    expect(classifyDestructiveTool('mcp__mailcopilot__apply_mail_action')).toBe('apply')
  })

  it('covers the pairs whose names do not follow the preview_*/apply_* order', () => {
    expect(classifyDestructiveTool('send_email_preview')).toBe('preview')
    expect(classifyDestructiveTool('send_email_apply')).toBe('apply')
    expect(classifyDestructiveTool('move_email_preview')).toBe('preview')
    expect(classifyDestructiveTool('move_email_apply')).toBe('apply')
  })

  it('does not classify read-only tools', () => {
    for (const name of ['search_emails', 'get_email', 'list_emails', 'query_db', 'get_thread']) {
      expect(classifyDestructiveTool(name)).toBeNull()
      expect(classifyDestructiveTool(`mcp__mailcopilot__${name}`)).toBeNull()
    }
  })

  it('does not classify a same-named tool from a DIFFERENT MCP server', () => {
    // Only our own namespace is stripped; another server's `preview_x` keeps
    // its prefix and therefore cannot be mistaken for our machinery.
    expect(classifyDestructiveTool('mcp__someserver__preview_mail_action')).toBeNull()
    expect(classifyDestructiveTool('mcp__someserver__apply_mail_action')).toBeNull()
  })

  it('handles an empty name without throwing', () => {
    expect(classifyDestructiveTool('')).toBeNull()
  })
})

describe('end-of-turn verdict', () => {
  it('(a) stays silent when the turn actually registered a preview', () => {
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__preview_mail_action')
    guard.notePreviewRegistered()

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: false, role: 'preview' })
  })

  it('(b) detects a destructive turn that armed nothing', () => {
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__search_emails')
    guard.noteToolCall('mcp__mailcopilot__preview_mail_action')

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: true, role: 'preview' })
  })

  it('(c) stays silent for a read-only turn', () => {
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__search_emails')
    guard.noteToolCall('mcp__mailcopilot__get_email')

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: false, role: null })
  })

  it('stays silent for a turn that called no tools at all', () => {
    const { guard } = guardWithRegistry()
    expect(guard.evaluateCompletedTurn().mismatch).toBe(false)
  })

  it('reports an apply-only turn as destructive intent (apply without a preview)', () => {
    // The model tried to execute an action it never prepared. The apply path
    // rejects it on the missing token; the user still deserves to be told why
    // no button appeared.
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__apply_mail_action')

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: true, role: 'apply' })
  })

  it('keeps the FIRST observed role when a turn touches both halves', () => {
    const { guard } = guardWithRegistry()
    guard.noteToolCall('preview_snooze_email')
    guard.noteToolCall('apply_snooze_email')

    expect(guard.evaluateCompletedTurn().role).toBe('preview')
  })

  it('stays silent when the turn APPLIED an action the user had already confirmed', () => {
    // The confirmation click lands in a LATER turn (the panel sends "proceed,
    // token=…"), and a successful claim deletes the registry entry — so this
    // turn calls a destructive tool, registers nothing, and leaves a registry
    // that shrank. Telling the user "nothing was prepared, nothing changed"
    // here would be a lie told immediately after the mailbox changed.
    const { guard } = guardWithRegistry(['pv-armed-last-turn'])
    guard.noteToolCall('mcp__mailcopilot__apply_mail_action')
    guard.notePreparedActionClaimed()

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: false, role: 'apply' })
  })

  it('still reports an apply whose token was missing or forged', () => {
    // The negative half of the case above: `notePreparedActionClaimed()` is
    // reported only AFTER the atomic claim validated the renderer-issued token,
    // so an apply that never passed that check leaves the mismatch standing.
    const { guard } = guardWithRegistry(['pv-armed-last-turn'])
    guard.noteToolCall('mcp__mailcopilot__apply_mail_action')

    expect(guard.evaluateCompletedTurn()).toMatchObject({ mismatch: true, role: 'apply' })
  })

  it('treats a registry entry that appeared DURING the turn as preparation', () => {
    // Last-resort witness: if the in-turn registration signal were ever lost on
    // some provider path, a new registry entry still suggests the button exists
    // — and a false "nothing was prepared" next to a live Apply button is the
    // one failure of this guard that would damage trust.
    const { guard, registry } = guardWithRegistry()
    guard.noteToolCall('preview_mail_action')
    registry.push('pv-new')

    expect(guard.evaluateCompletedTurn().mismatch).toBe(false)
  })

  it('does not let a CONCURRENT chat exonerate a turn that never previewed anything', () => {
    // The registry is process-global and its entries carry no owning request,
    // so a preview armed by chat B looks "new" to chat A as well. A turn that
    // only reached for the apply half has no preview of its own to attribute it
    // to, so the fallback does not apply and the mismatch stands.
    const registry: string[] = []
    const listPreviewIds = () => [...registry]
    const chatA = createTurnGuard({ requestId: 'req-a', listPreviewIds })
    const chatB = createTurnGuard({ requestId: 'req-b', listPreviewIds })

    chatA.noteToolCall('apply_mail_action') // no token ever claimed
    // Chat B does real work in parallel.
    chatB.noteToolCall('preview_mail_action')
    chatB.notePreviewRegistered()
    registry.push('pv-from-chat-b')

    expect(chatA.evaluateCompletedTurn().mismatch).toBe(true)
    expect(chatB.evaluateCompletedTurn().mismatch).toBe(false)
  })

  it('does NOT count a preview left over from an earlier turn as preparation', () => {
    const { guard } = guardWithRegistry(['pv-from-previous-turn'])
    guard.noteToolCall('preview_mail_action')

    expect(guard.evaluateCompletedTurn().mismatch).toBe(true)
  })

  it('survives a registry read that throws', () => {
    const guard = createTurnGuard({
      requestId: 'req-throw',
      listPreviewIds: () => { throw new Error('registry down') },
    })
    guard.noteToolCall('preview_mail_action')

    expect(() => guard.evaluateCompletedTurn()).not.toThrow()
    expect(guard.evaluateCompletedTurn().mismatch).toBe(true)
  })

  it('handles several destructive calls of DIFFERENT kinds in one turn — role stays the first one observed', () => {
    // A turn is not guaranteed to touch only one kind of destructive tool.
    // The mismatch verdict is a single boolean for the whole turn, so this
    // documents that a later kind cannot overwrite the first-observed role.
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__preview_flag_email')
    guard.noteToolCall('mcp__mailcopilot__preview_snooze_email')
    guard.noteToolCall('mcp__mailcopilot__apply_mail_action')

    const verdict = guard.evaluateCompletedTurn()
    expect(verdict.mismatch).toBe(true)
    expect(verdict.role).toBe('preview')
  })

  it('DOCUMENTED LIMITATION: a preview registered for one action kind counts as "armed" even when a different kind was applied', () => {
    // notePreviewRegistered() carries no action-kind argument — it is a single
    // per-turn counter, not a per-kind ledger. So a turn that armed a
    // mail_action preview and THEN reached for apply_unsubscribe (a kind that
    // was never previewed) is read as "something was armed" rather than
    // "the WRONG thing was armed". Breaking this open (scoping the funnel by
    // kind) is tracked as a followup, not a defect fixed by this test — the
    // test exists so that decision is visible and does not regress silently
    // into "no kind ever needs to match" without anyone noticing the change.
    const { guard } = guardWithRegistry()
    guard.noteToolCall('mcp__mailcopilot__preview_mail_action')
    guard.notePreviewRegistered() // arms a mail_action preview
    guard.noteToolCall('mcp__mailcopilot__apply_unsubscribe') // different kind, never previewed

    expect(guard.evaluateCompletedTurn().mismatch).toBe(false)
  })
})

describe('search_emails repetition limiter', () => {
  const key = { accountId: 1, folder: 'INBOX', query: 'is:unread from:bob@example.com', offset: 0 }

  it('allows a search that has not been tried yet', () => {
    const { guard } = guardWithRegistry()
    expect(guard.decideSearch(key)).toEqual({ allowed: true })
  })

  it('refuses an exact repeat of a search that already came back empty', () => {
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 0)

    const decision = guard.decideSearch(key)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('repeat_empty_search')
    expect(decision.message.length).toBeGreaterThan(0)
  })

  it('ignores case and whitespace when deciding what counts as the same search', () => {
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 0)

    const decision = guard.decideSearch({ ...key, query: '  IS:UNREAD   from:Bob@Example.com ' })
    expect(decision.allowed).toBe(false)
  })

  it('does not confuse a folder/query split with the same characters', () => {
    // folder="A B" query="C" must not collide with folder="A" query="B C".
    const { guard } = guardWithRegistry()
    const first = { accountId: 1, folder: 'A B', query: 'C', offset: 0 }
    guard.decideSearch(first)
    guard.noteSearchResult(first, 0)

    expect(guard.decideSearch({ accountId: 1, folder: 'A', query: 'B C', offset: 0 })).toEqual({ allowed: true })
  })

  it('does not let an empty page deep in a sweep block a restart from the top', () => {
    // `offset` changes the answer: nothing at offset 100 says nothing about
    // offset 0. Treating them as the same search would strand the model on a
    // paginated sweep it is no longer allowed to restart.
    const { guard } = guardWithRegistry()
    const deepPage = { ...key, offset: 100 }
    guard.decideSearch(deepPage)
    guard.noteSearchResult(deepPage, 0)

    expect(guard.decideSearch({ ...key, offset: 0 })).toEqual({ allowed: true })
    // …and the dead page itself is still refused on a repeat.
    expect(guard.decideSearch(deepPage).allowed).toBe(false)
  })

  it('does not let a different limit re-open the same dead search', () => {
    // The mirror image of the offset case: a narrower or wider window cannot
    // turn an empty page into a non-empty one, so `limit` is deliberately not
    // part of the identity — otherwise it becomes a knob for re-issuing the
    // identical fruitless search under a fresh key.
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 0)

    // Same key object shape; the caller in ai.ts never passes `limit` at all.
    expect(guard.decideSearch({ ...key }).allowed).toBe(false)
  })

  it('does NOT cut a legitimate multi-account sweep (one call = one account)', () => {
    const { guard } = guardWithRegistry()
    // The same query across five accounts, all empty — normal unified-inbox
    // triage, and every one of them must run.
    for (let accountId = 1; accountId <= 5; accountId++) {
      const perAccount = { ...key, accountId }
      expect(guard.decideSearch(perAccount)).toEqual({ allowed: true })
      guard.noteSearchResult(perAccount, 0)
    }
  })

  it('never limits searches that keep finding mail', () => {
    const { guard } = guardWithRegistry()
    for (let i = 0; i < SEARCH_EMAILS_EMPTY_BUDGET * 3; i++) {
      const productive = { ...key, query: `subject:report-${i}` }
      expect(guard.decideSearch(productive)).toEqual({ allowed: true })
      guard.noteSearchResult(productive, 5)
    }
  })

  it('allows repeating a search that DID return results', () => {
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 3)

    expect(guard.decideSearch(key)).toEqual({ allowed: true })
  })

  it('refuses further searching once the empty-result budget is spent', () => {
    const { guard } = guardWithRegistry()
    for (let i = 0; i < SEARCH_EMAILS_EMPTY_BUDGET; i++) {
      const distinct = { ...key, query: `subject:nothing-${i}` }
      expect(guard.decideSearch(distinct).allowed).toBe(true)
      guard.noteSearchResult(distinct, 0)
    }

    const decision = guard.decideSearch({ ...key, query: 'subject:one-more-try' })
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable')
    expect(decision.reason).toBe('empty_search_budget_exhausted')
    expect(decision.emptySearches).toBe(SEARCH_EMAILS_EMPTY_BUDGET)
  })

  it('gives every account its first search even after the budget is spent', () => {
    // The multi-account regression: with nine mailboxes and nothing to find,
    // a purely global budget refuses the ninth account BEFORE anyone looked in
    // it, and the user is told "nothing matched" about a mailbox that was never
    // searched. One first look per account is exempt.
    const { guard } = guardWithRegistry()
    const accounts = SEARCH_EMAILS_EMPTY_BUDGET + 1

    for (let accountId = 1; accountId <= accounts; accountId++) {
      const perAccount = { ...key, accountId }
      expect(guard.decideSearch(perAccount)).toEqual({ allowed: true })
      guard.noteSearchResult(perAccount, 0)
    }

    // Every account ran exactly once…
    expect(guard.evaluateCompletedTurn().searchCalls).toBe(accounts)
    // …and the budget still bites for a SECOND search of an account already
    // probed, which is the spin the limiter exists to stop.
    const secondLook = guard.decideSearch({ ...key, accountId: 1, query: 'subject:anything-else' })
    expect(secondLook.allowed).toBe(false)
    if (secondLook.allowed) throw new Error('unreachable')
    expect(secondLook.reason).toBe('empty_search_budget_exhausted')
  })

  it('gives EVERY configured account its first search, past any fixed ceiling', () => {
    // The anti-abuse ceiling must not be a ceiling on how many mailboxes a user
    // may own: with more accounts configured than the fallback limit, a fixed
    // cap would refuse the last few BEFORE anyone looked in them — the same
    // dishonesty as the original global-budget bug, one size larger.
    const accounts = SEARCH_EMAILS_ACCOUNT_LIMIT + 4
    const configured = Array.from({ length: accounts }, (_, i) => i + 1)
    const guard = guardWithAccounts(() => configured)

    for (const accountId of configured) {
      const perAccount = { ...key, accountId }
      expect(guard.decideSearch(perAccount)).toEqual({ allowed: true })
      guard.noteSearchResult(perAccount, 0)
    }
    expect(guard.evaluateCompletedTurn().searchCalls).toBe(accounts)
  })

  it('still holds a configured account to the budget on its SECOND search', () => {
    const configured = Array.from({ length: SEARCH_EMAILS_ACCOUNT_LIMIT + 4 }, (_, i) => i + 1)
    const guard = guardWithAccounts(() => configured)
    for (const accountId of configured) {
      const perAccount = { ...key, accountId }
      expect(guard.decideSearch(perAccount).allowed).toBe(true)
      guard.noteSearchResult(perAccount, 0)
    }

    const secondLook = guard.decideSearch({ ...key, accountId: 1, query: 'subject:anything-else' })
    expect(secondLook.allowed).toBe(false)
    if (secondLook.allowed) throw new Error('unreachable')
    expect(secondLook.reason).toBe('empty_search_budget_exhausted')
  })

  it('caps the exemption for ids that are NOT configured accounts', () => {
    // Walking invented account ids is the abuse the ceiling exists for: those
    // ids can find nothing, so all they could do is mint search budget.
    const guard = guardWithAccounts(() => [1])
    // Spend the global budget on the one real mailbox.
    for (let i = 0; i < SEARCH_EMAILS_EMPTY_BUDGET; i++) {
      const distinct = { ...key, accountId: 1, query: `subject:nothing-${i}` }
      expect(guard.decideSearch(distinct).allowed).toBe(true)
      guard.noteSearchResult(distinct, 0)
    }

    // A couple of unconfigured ids still get their first look — cheap, and it
    // covers an account added or removed while the turn was running.
    for (let i = 0; i < SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT; i++) {
      const invented = { ...key, accountId: 9000 + i }
      expect(guard.decideSearch(invented)).toEqual({ allowed: true })
      guard.noteSearchResult(invented, 0)
    }

    const beyond = guard.decideSearch({ ...key, accountId: 9000 + SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT })
    expect(beyond.allowed).toBe(false)
    if (beyond.allowed) throw new Error('unreachable')
    expect(beyond.reason).toBe('empty_search_budget_exhausted')
  })

  it('falls back to the fixed ceiling when the account list cannot be read', () => {
    // "Unknown" is not "unconfigured": a store read that throws must not start
    // refusing first looks at real mailboxes, so the degraded path keeps the
    // pre-fix behaviour — any distinct id, capped at the fallback ceiling.
    const guard = guardWithAccounts(() => { throw new Error('store unavailable') })
    for (let accountId = 1; accountId <= SEARCH_EMAILS_ACCOUNT_LIMIT; accountId++) {
      const perAccount = { ...key, accountId }
      expect(guard.decideSearch(perAccount).allowed).toBe(true)
      guard.noteSearchResult(perAccount, 0)
    }

    const beyond = guard.decideSearch({ ...key, accountId: SEARCH_EMAILS_ACCOUNT_LIMIT + 1 })
    expect(beyond.allowed).toBe(false)
    if (beyond.allowed) throw new Error('unreachable')
    expect(beyond.reason).toBe('empty_search_budget_exhausted')
  })

  it('reads the configured account list once per turn', () => {
    const listConfiguredAccountIds = vi.fn(() => [1, 2])
    const guard = guardWithAccounts(listConfiguredAccountIds)
    for (let i = 0; i < 5; i++) {
      const distinct = { ...key, accountId: (i % 2) + 1, query: `subject:nothing-${i}` }
      guard.decideSearch(distinct)
      guard.noteSearchResult(distinct, 0)
    }

    expect(listConfiguredAccountIds).toHaveBeenCalledTimes(1)
  })

  it('does not touch the account list at all in a turn that never searches', () => {
    const listConfiguredAccountIds = vi.fn(() => [1])
    const guard = guardWithAccounts(listConfiguredAccountIds)
    guard.noteToolCall('preview_mail_action')
    guard.evaluateCompletedTurn()

    expect(listConfiguredAccountIds).not.toHaveBeenCalled()
  })

  it('counts refused calls as searches neither run nor charged', () => {
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 0)
    guard.decideSearch(key) // refused
    guard.decideSearch(key) // refused

    // One search actually ran in this turn.
    expect(guard.evaluateCompletedTurn().searchCalls).toBe(1)
  })

  it('refusing a repeat does not itself spend the empty-search budget', () => {
    // A refused call never reaches noteSearchResult() (the caller in ai.ts
    // returns the refusal without querying the DB), so retrying the same
    // dead search many times must not push `emptySearches` toward the budget
    // on its own — only genuinely NEW empty searches may do that.
    const { guard } = guardWithRegistry()
    guard.decideSearch(key)
    guard.noteSearchResult(key, 0) // the one and only real empty search so far

    for (let i = 0; i < SEARCH_EMAILS_EMPTY_BUDGET * 2; i++) {
      const decision = guard.decideSearch(key)
      expect(decision.allowed).toBe(false)
      if (decision.allowed) throw new Error('unreachable')
      expect(decision.reason).toBe('repeat_empty_search')
    }

    // A brand-new empty search must still be allowed — the budget was not
    // secretly exhausted by the repeat refusals above.
    const fresh = { ...key, query: 'something else entirely' }
    expect(guard.decideSearch(fresh)).toEqual({ allowed: true })
  })
})

describe('ambient turn guard (AsyncLocalStorage)', () => {
  it('is undefined outside a turn — tools called by MCP export are not limited', () => {
    expect(currentTurnGuard()).toBeUndefined()
  })

  it('is reachable from code running inside the turn scope', () => {
    const { guard } = guardWithRegistry()
    runWithTurnGuard(guard, () => {
      expect(currentTurnGuard()).toBe(guard)
    })
    expect(currentTurnGuard()).toBeUndefined()
  })

  it('keeps two interleaved turns apart', async () => {
    const a = guardWithRegistry().guard
    const b = guardWithRegistry().guard

    await Promise.all([
      runWithTurnGuard(a, async () => {
        await Promise.resolve()
        currentTurnGuard()?.noteToolCall('preview_mail_action')
      }),
      runWithTurnGuard(b, async () => {
        await Promise.resolve()
        currentTurnGuard()?.noteToolCall('search_emails')
      }),
    ])

    expect(a.evaluateCompletedTurn().role).toBe('preview')
    expect(b.evaluateCompletedTurn().role).toBeNull()
  })
})

describe('telemetry', () => {
  it('emits one PII-free event per mismatch', () => {
    recordTurnGuardMismatch({ mismatch: true, role: 'preview', searchCalls: 18 })

    expect(recordEventMock).toHaveBeenCalledTimes(1)
    expect(recordEventMock).toHaveBeenCalledWith('ai.turn.action_not_prepared', {
      role: 'preview',
      search_calls_bucket: '11-20',
    })
  })

  it('never throws back into the turn when the metrics pipeline fails', () => {
    recordEventMock.mockImplementationOnce(() => { throw new Error('metrics down') })
    expect(() => recordTurnGuardMismatch({ mismatch: true, role: 'apply', searchCalls: 0 })).not.toThrow()
  })
})
