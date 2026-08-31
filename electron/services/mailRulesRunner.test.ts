import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runMailRules,
  MAIL_RULES_MAX_PER_PASS,
  MAIL_RULES_MAX_ROUNDS,
  MAIL_RULES_MAX_ACTION_ATTEMPTS,
  type MailRulesRunnerDeps,
  type MailRulesRunnerRule,
  type MailRulesRunnerMessage,
} from './mailRulesRunner'

const ACCOUNT = 5
const FOLDER = 'INBOX'

/**
 * A rule that trashes everything from the given address.
 *
 * Gated on `from_address`, not the legacy `from`: since §2.162 a destructive
 * action on the legacy field is refused before evaluation (the sender writes
 * that value about themselves), so a fixture written that way would be testing
 * the refusal rather than the loop.
 */
function trashRule(overrides: Partial<MailRulesRunnerRule> = {}): MailRulesRunnerRule {
  return {
    id: 'rule-1',
    accountId: String(ACCOUNT),
    name: 'trash spam sender',
    enabled: true,
    priority: 0,
    conditions: JSON.stringify([{ field: 'from_address', op: 'equals', value: 'cp@mai.ru' }]),
    actions: JSON.stringify([{ type: 'trash' }]),
    stopProcessing: false,
    ...overrides,
  }
}

function message(from = 'cp@mai.ru'): MailRulesRunnerMessage {
  return {
    subject: 'notification',
    from,
    fromAddr: from,
    toAddr: 'user@example.com',
    bodyText: 'body',
    hasAttachments: false,
  }
}

interface Harness {
  deps: MailRulesRunnerDeps
  /** Simulated message store: uid → message. */
  store: Map<number, MailRulesRunnerMessage>
  /** Persisted watermark state, or undefined when never written. */
  state: { watermarkUid: number; uidValidity: number | null } | undefined
  /** Every watermark write, in order — proves per-message advancement. */
  watermarkWrites: number[]
  executed: Array<{ uid: number; action: string }>
  enqueuedForAi: number[]
  logged: number[]
  warnings: string[]
  captured: Array<{ err: unknown; context: Record<string, unknown> }>
  uidValidity: number | null
}

function harness(opts: {
  rules?: MailRulesRunnerRule[]
  uids?: number[]
  state?: { watermarkUid: number; uidValidity: number | null }
  uidValidity?: number | null
  executeRuleAction?: (accountId: number, folder: string, uid: number, action: { type: string }) => Promise<void>
} = {}): Harness {
  const store = new Map<number, MailRulesRunnerMessage>()
  for (const uid of opts.uids ?? []) store.set(uid, message())

  const h: Harness = {
    store,
    state: opts.state,
    watermarkWrites: [],
    executed: [],
    enqueuedForAi: [],
    logged: [],
    warnings: [],
    captured: [],
    uidValidity: opts.uidValidity ?? 1,
    deps: null as unknown as MailRulesRunnerDeps,
  }

  h.deps = {
    inFlight: new Set<string>(),
    // Both of these are process-lifetime collections in main.ts, so the harness
    // holds ONE instance across every runMailRules call in a test — that is what
    // makes the remembered-trigger and bounded-retry tests meaningful.
    pendingRerun: new Set<string>(),
    actionAttempts: new Map<string, number>(),
    listMailRules: () => opts.rules ?? [trashRule()],
    getMailRulesState: () => h.state,
    setMailRulesState: (_a, _f, watermarkUid, uidValidity) => {
      h.state = { watermarkUid, uidValidity }
      h.watermarkWrites.push(watermarkUid)
    },
    getUidValidity: () => h.uidValidity,
    getMaxUidForFolder: () => (h.store.size === 0 ? 0 : Math.max(...h.store.keys())),
    getUidsForRulesSince: (_a, _f, sinceUid, limit) =>
      [...h.store.keys()].filter(u => u > sinceUid).sort((a, b) => a - b).slice(0, limit),
    getMessageByUid: (_a, _f, uid) => h.store.get(uid),
    executeRuleAction: opts.executeRuleAction
      ? (a, f, uid, action) => opts.executeRuleAction!(a, f, uid, action)
      : async (_a, _f, uid, action) => { h.executed.push({ uid, action: action.type }) },
    insertRuleLog: (data) => { h.logged.push(data.uid) },
    enqueueForAiRules: (item) => { h.enqueuedForAi.push(item.uid) },
    log: { info: () => {}, warn: (msg) => { h.warnings.push(msg) }, error: () => {} },
    captureException: (err, context) => { h.captured.push({ err, context }) },
  }
  return h
}

describe('runMailRules — baselining', () => {
  it('baselines an unseen folder to the highest cached UID and evaluates nothing', async () => {
    // Enabling a rule must never retroactively act on a mailbox full of old
    // mail — retroactive application stays an explicit user action. Note this
    // LAZY baseline is the SECONDARY path (folders discovered after startup);
    // the primary one is seedMailRulesStateFromCache() at process start.
    const h = harness({ uids: [10, 11, 12] })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result).toEqual({ evaluated: 0, matched: 0, baselined: true, skipped: false, aborted: false })
    expect(h.executed).toEqual([])
    expect(h.state).toEqual({ watermarkUid: 12, uidValidity: 1 })
  })

  it('baselines an empty folder at 0 so the first arrival is evaluated', async () => {
    const h = harness({ uids: [] })

    await runMailRules(ACCOUNT, FOLDER, h.deps)
    expect(h.state).toEqual({ watermarkUid: 0, uidValidity: 1 })

    h.store.set(1, message())
    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.evaluated).toBe(1)
    expect(h.executed).toEqual([{ uid: 1, action: 'trash' }])
  })

  it('re-baselines instead of sweeping when UIDVALIDITY changed', async () => {
    // The stored watermark belongs to a different UID numbering space; comparing
    // across the bump would be meaningless in either direction.
    const h = harness({ uids: [10, 11], state: { watermarkUid: 5, uidValidity: 1 } })
    h.uidValidity = 2

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.baselined).toBe(true)
    expect(h.executed).toEqual([])
    expect(h.state).toEqual({ watermarkUid: 11, uidValidity: 2 })
  })

  it('adopts a newly-known UIDVALIDITY instead of re-baselining (seeded folder, first sync)', async () => {
    // seedMailRulesStateFromCache() copies uid_validity from sync_state, which
    // is NULL for a folder that has never been synced. Treating unknown → known
    // as a bump would re-baseline right after the first sync and swallow exactly
    // the mail that sync just fetched — the §2.86 defect, reintroduced through
    // the seed. Unknown is not a different numbering space, it is no answer.
    const h = harness({ uids: [10, 11], state: { watermarkUid: 9, uidValidity: null } })
    h.uidValidity = 7

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.baselined).toBe(false)
    expect(result.evaluated).toBe(2)
    expect(h.executed).toEqual([
      { uid: 10, action: 'trash' },
      { uid: 11, action: 'trash' },
    ])
    expect(h.state).toEqual({ watermarkUid: 11, uidValidity: 7 })
  })

  it('keeps a recorded UIDVALIDITY when the live value is momentarily unknown', async () => {
    // A missing sync_state row must not erase what we already recorded —
    // overwriting it with NULL would make the next real bump undetectable.
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 3 } })
    h.uidValidity = null

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.state).toEqual({ watermarkUid: 10, uidValidity: 3 })
  })
})

describe('runMailRules — evaluation', () => {
  it('applies a matching rule and logs the execution', async () => {
    const h = harness({ uids: [7], state: { watermarkUid: 6, uidValidity: 1 } })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result).toEqual({ evaluated: 1, matched: 1, baselined: false, skipped: false, aborted: false })
    expect(h.executed).toEqual([{ uid: 7, action: 'trash' }])
    expect(h.logged).toEqual([7])
    expect(h.state?.watermarkUid).toBe(7)
  })

  it('hands non-matching messages to the AI-rules pipeline', async () => {
    const h = harness({ state: { watermarkUid: 0, uidValidity: 1 } })
    h.store.set(1, message('someone@example.com'))

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    expect(h.enqueuedForAi).toEqual([1])
  })

  it('skips rules scoped to a different account', async () => {
    const h = harness({
      rules: [trashRule({ accountId: '99' })],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    expect(h.enqueuedForAi).toEqual([7])
  })

  it('applies a global (accountId: null) rule', async () => {
    const h = harness({
      rules: [trashRule({ accountId: null })],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 7, action: 'trash' }])
  })

  it('ignores a rule whose stored JSON is malformed instead of failing the pass', async () => {
    const h = harness({
      rules: [trashRule({ id: 'broken', conditions: '{not json' }), trashRule({ id: 'ok' })],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 7, action: 'trash' }])
  })

  it('stops at the first stopProcessing hit', async () => {
    const h = harness({
      rules: [
        trashRule({ id: 'first', priority: 0, actions: JSON.stringify([{ type: 'mark_read' }]), stopProcessing: true }),
        trashRule({ id: 'second', priority: 1 }),
      ],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 7, action: 'mark_read' }])
  })

  it('skips a disabled rule instead of matching it', async () => {
    // `listMailRules` can return disabled rows verbatim (row.enabled reflects
    // storage); the runner itself is responsible for filtering them out before
    // `matchRule` ever sees one. Without the `.filter(r => r.enabled)` in
    // `runMailRules`, this message would hit the (disabled) trash rule.
    const h = harness({
      rules: [trashRule({ enabled: false })],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    expect(h.enqueuedForAi).toEqual([7])
  })

  it('applies actions from every non-stopProcessing matching rule in priority order, counting the message once', async () => {
    const h = harness({
      rules: [
        trashRule({ id: 'mark', priority: 0, actions: JSON.stringify([{ type: 'mark_read' }]), stopProcessing: false }),
        trashRule({ id: 'trash', priority: 1, actions: JSON.stringify([{ type: 'trash' }]), stopProcessing: false }),
      ],
      uids: [7],
      state: { watermarkUid: 6, uidValidity: 1 },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    // Both rules matched and neither stops processing, so both actions run —
    // in priority order — but the message counts as matched exactly once.
    expect(result.matched).toBe(1)
    expect(h.executed).toEqual([
      { uid: 7, action: 'mark_read' },
      { uid: 7, action: 'trash' },
    ])
  })
})

describe('runMailRules — watermark ownership (2026-07-30 regression)', () => {
  it('still evaluates a message that some other writer already put in the cache', async () => {
    // This is the actual bug: pagination / FLAGS-only sync / an interrupted sync
    // persisted a message and thereby raised MAX(uid) above it, and the old
    // `uid > MAX(uid)` discovery could then never reach it. The watermark is now
    // owned by this runner, so an unrelated writer cannot hide a message.
    const h = harness({ state: { watermarkUid: 100, uidValidity: 1 } })
    h.store.set(150, message())   // written by a path that never ran rules
    h.store.set(151, message())   // and another one after it

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.evaluated).toBe(2)
    expect(h.executed).toEqual([
      { uid: 150, action: 'trash' },
      { uid: 151, action: 'trash' },
    ])
  })

  it('advances the watermark per message so an interrupted pass leaves a contiguous tail', async () => {
    const h = harness({
      uids: [10, 11, 12],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.watermarkWrites).toEqual([10, 11, 12])
  })

  it('does not re-evaluate messages a previous pass already handled', async () => {
    const h = harness({ uids: [10, 11], state: { watermarkUid: 9, uidValidity: 1 } })

    await runMailRules(ACCOUNT, FOLDER, h.deps)
    const afterFirst = [...h.executed]
    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual(afterFirst)
  })
})

describe('runMailRules — draining the backlog (§2.86 iter2, lost wake-up)', () => {
  it('keeps going past the per-pass cap until the folder is drained, without another trigger', async () => {
    // The cap bounds one DB query, not one invocation. Leaving the remainder for
    // "some later trigger" is the same lost-wake-up defect as the busy-key case
    // below: a batch of 205 arrivals would strand five messages until an
    // unrelated sync happened to run.
    const total = MAIL_RULES_MAX_PER_PASS + 5
    const uids = Array.from({ length: total }, (_, i) => i + 1)
    const h = harness({ uids, state: { watermarkUid: 0, uidValidity: 1 } })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.evaluated).toBe(total)
    expect(h.executed).toHaveLength(total)
    expect(h.state?.watermarkUid).toBe(total)
  })

  it('stops after MAIL_RULES_MAX_ROUNDS so one invocation cannot run away, leaving the rest for the next trigger', async () => {
    const ceiling = MAIL_RULES_MAX_ROUNDS * MAIL_RULES_MAX_PER_PASS
    const total = ceiling + 3
    const uids = Array.from({ length: total }, (_, i) => i + 1)
    const h = harness({ uids, state: { watermarkUid: 0, uidValidity: 1 } })

    const first = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(first.evaluated).toBe(ceiling)
    expect(h.warnings.some(w => w.includes('round cap'))).toBe(true)

    // Nothing is lost — the watermark is contiguous and the next trigger
    // finishes the job.
    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)
    expect(second.evaluated).toBe(3)
    expect(h.executed).toHaveLength(total)
  })

  it('replays a trigger that arrived while a pass was running (busy key must not lose the wake-up)', async () => {
    // The running pass sampled its UID list before uid 11 was persisted. Under
    // the first cut the second call just returned `skipped` and uid 11 waited
    // for an unrelated future trigger.
    const h = harness({ state: { watermarkUid: 9, uidValidity: 1 } })
    h.store.set(10, message())
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      await gate
      h.executed.push({ uid, action: action.type })
    }

    const first = runMailRules(ACCOUNT, FOLDER, h.deps)
    // A writer that does not run rules (pagination, remote search) persists a
    // message while the pass is parked on its action.
    h.store.set(11, message())
    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)
    expect(second.skipped).toBe(true)

    release()
    const result = await first

    expect(result.evaluated).toBe(2)
    expect(h.executed).toEqual([
      { uid: 10, action: 'trash' },
      { uid: 11, action: 'trash' },
    ])
    expect(h.deps.pendingRerun.size).toBe(0)
  })

  it('is single-flight per folder — the skipped call itself does no work', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      await gate
      h.executed.push({ uid, action: action.type })
    }

    const first = runMailRules(ACCOUNT, FOLDER, h.deps)
    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)
    release()
    await first

    expect(second.skipped).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'trash' }])
    // The skipped pass must not touch the watermark at all — only the first,
    // still-running pass's eventual write should land.
    expect(h.watermarkWrites).toEqual([10])
  })
})

describe('runMailRules — UID numbering space changing mid-pass', () => {
  it('stops before acting when UIDVALIDITY changed since the pass started', async () => {
    // A concurrent sync writes message rows BEFORE it updates sync_state, so a
    // bump can land mid-pass. Acting on a REUSED uid with a decision made in the
    // old space is the one failure mode here that destroys mail: uid 11 in the
    // new space is a brand-new message, and the pending action is `trash`.
    const h = harness({ uids: [10, 11], state: { watermarkUid: 9, uidValidity: 1 } })
    const realGet = h.deps.getMessageByUid
    h.deps.getMessageByUid = (a, f, uid) => {
      if (uid === 11) h.uidValidity = 2   // server reassigned UIDs, mid-pass
      return realGet(a, f, uid)
    }

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'trash' }])   // uid 11 untouched
    expect(h.watermarkWrites).toEqual([10])                       // and not marked done
  })

  it('does not advance the watermark when the space changes after the action ran', async () => {
    const h = harness({ uids: [10, 11], state: { watermarkUid: 9, uidValidity: 1 } })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      h.executed.push({ uid, action: action.type })
      h.uidValidity = 2
    }

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'trash' }])
    // Watermark untouched: the next pass sees the mismatch and re-baselines
    // through the normal branch instead of trusting a cross-space number.
    expect(h.watermarkWrites).toEqual([])
    expect(h.state).toEqual({ watermarkUid: 9, uidValidity: 1 })
  })

  it('re-reads the space before EVERY action, not once per message (§2.86 iter3)', async () => {
    // Two rules match the same message, so two IMAP round-trips run back to
    // back. The bump lands between them. Checking once per message let the
    // second action run in a numbering space that no longer matched the
    // decision — acting on a reused UID, which is the mail-destroying case.
    const h = harness({
      rules: [
        trashRule({ id: 'mark', priority: 0, actions: JSON.stringify([{ type: 'mark_read' }]) }),
        trashRule({ id: 'trash', priority: 1, actions: JSON.stringify([{ type: 'trash' }]) }),
      ],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      h.executed.push({ uid, action: action.type })
      if (action.type === 'mark_read') h.uidValidity = 2   // concurrent sync, mid-message
    }

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'mark_read' }])   // `trash` never ran
    // Partially applied, so the message is NOT marked done: the next pass
    // re-baselines through the normal branch.
    expect(h.watermarkWrites).toEqual([])
  })

  it('checks the space before every action within a single rule, not once per rule, and the next pass does not repeat the first action', async () => {
    // The previous test proves the check runs between two DIFFERENT rules; that
    // passes even if the check were hoisted to run once per RULE instead of
    // once per action, because each of those rules had exactly one action. A
    // single rule with two actions is the case only a genuine per-action check
    // catches: the bump lands between action #1 and action #2 of the SAME rule,
    // and the second must not run.
    const h = harness({
      rules: [
        trashRule({
          id: 'multi',
          actions: JSON.stringify([{ type: 'mark_read' }, { type: 'trash' }]),
        }),
      ],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      h.executed.push({ uid, action: action.type })
      if (action.type === 'mark_read') h.uidValidity = 2   // concurrent sync, mid-rule
    }

    const first = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(first.aborted).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'mark_read' }])   // `trash` never ran
    expect(h.watermarkWrites).toEqual([])
    expect(h.state).toEqual({ watermarkUid: 9, uidValidity: 1 })

    // The reviewer's claim is that partial application is safe BECAUSE the old
    // uid no longer addresses the same message once the space changes — which
    // only holds if the next pass re-anchors instead of resuming and replaying
    // the already-applied `mark_read`.
    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(second.baselined).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'mark_read' }])   // unchanged
    expect(h.state).toEqual({ watermarkUid: 10, uidValidity: 2 })
  })

  it('does not hand a message to the AI-rules pipeline after the space changed (§2.86 iter3)', async () => {
    // The AI pipeline acts on (folder, uid) later and on its own schedule, so
    // queueing a UID from a space that was just reassigned defers the same
    // hazard instead of avoiding it.
    const h = harness({ rules: [], uids: [10, 11], state: { watermarkUid: 9, uidValidity: 1 } })
    const realGet = h.deps.getMessageByUid
    h.deps.getMessageByUid = (a, f, uid) => {
      if (uid === 11) h.uidValidity = 2
      return realGet(a, f, uid)
    }

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.enqueuedForAi).toEqual([10])
    expect(h.watermarkWrites).toEqual([10])
  })

  it('does not chain another round after an aborted one', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })
    let rounds = 0
    const realSince = h.deps.getUidsForRulesSince
    h.deps.getUidsForRulesSince = (a, f, since, limit) => { rounds++; return realSince(a, f, since, limit) }
    h.deps.executeRuleAction = async () => { h.uidValidity = 2 }

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(rounds).toBe(1)
  })
})

describe('runMailRules — a failed action must not lose the rule (§2.86 iter2)', () => {
  it('leaves the watermark put and retries the message on the next pass', async () => {
    // The first cut stepped over the message (Thunderbird's behaviour) and
    // reported to Sentry. That turns a dropped IMAP connection into the
    // permanent loss of a rule the user explicitly configured — and Sentry does
    // not repair user state.
    let failures = 0
    const h = harness({
      uids: [10, 11],
      state: { watermarkUid: 9, uidValidity: 1 },
      executeRuleAction: async (_a, _f, uid, action) => {
        if (uid === 10 && failures === 0) { failures++; throw new Error('Connection not available') }
        h.executed.push({ uid, action: action.type })
      },
    })

    const first = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(first.aborted).toBe(true)
    expect(first.evaluated).toBe(0)
    expect(h.executed).toEqual([])
    // Neither uid 10 nor the tail behind it was marked done.
    expect(h.watermarkWrites).toEqual([])
    expect(h.state).toEqual({ watermarkUid: 9, uidValidity: 1 })
    expect(h.captured).toEqual([])   // not a give-up yet, so no Sentry event

    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(second.evaluated).toBe(2)
    expect(h.executed).toEqual([
      { uid: 10, action: 'trash' },
      { uid: 11, action: 'trash' },
    ])
    expect(h.state?.watermarkUid).toBe(11)
  })

  it('gives up after MAIL_RULES_MAX_ACTION_ATTEMPTS so one poisonous message cannot wedge the folder', async () => {
    const h = harness({
      uids: [10, 11],
      state: { watermarkUid: 9, uidValidity: 1 },
      executeRuleAction: async (_a, _f, uid, action) => {
        if (uid === 10) throw new Error('NO [CANNOT] rejected by "Входящие/Работа"')
        h.executed.push({ uid, action: action.type })
      },
    })

    for (let i = 1; i < MAIL_RULES_MAX_ACTION_ATTEMPTS; i++) {
      const attempt = await runMailRules(ACCOUNT, FOLDER, h.deps)
      expect(attempt.aborted).toBe(true)
      expect(h.state?.watermarkUid).toBe(9)
      expect(h.captured).toEqual([])
    }

    const final = await runMailRules(ACCOUNT, FOLDER, h.deps)

    // Message given up on, folder unblocked: uid 11 gets its rule.
    expect(final.aborted).toBe(false)
    expect(h.executed).toEqual([{ uid: 11, action: 'trash' }])
    expect(h.state?.watermarkUid).toBe(11)

    // Exactly one report, carrying the attempt count so the give-up is
    // distinguishable from a one-off failure.
    expect(h.captured).toHaveLength(1)
    expect(h.captured[0].context).toEqual({
      source: 'mailRulesRunner',
      attempts: MAIL_RULES_MAX_ACTION_ATTEMPTS,
      error_class: 'unknown',
    })
    const reported = h.captured[0].err as Error
    expect(reported.name).toBe('MailRulesActionDropped')
    expect(reported.message).toContain(String(MAIL_RULES_MAX_ACTION_ATTEMPTS))

    // PII invariant (CLAUDE.md §8 / ARCHITECTURE "Свободный текст третьей
    // стороны не передаётся"): neither the folder name nor the server's own
    // text may reach Sentry. Both appear in the thrown error above.
    const payload = JSON.stringify(h.captured[0].context) + reported.message + reported.name
    expect(payload).not.toContain(FOLDER)
    expect(payload).not.toContain('Входящие')
    expect(payload).not.toContain('rejected by')
  })

  it('grants a fresh attempt budget after a restart (attempts live in memory only)', async () => {
    let attempts = 0
    const executeRuleAction = async (_a: number, _f: string, uid: number) => {
      if (uid === 10) { attempts++; throw new Error('Connection not available') }
    }
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 }, executeRuleAction })

    for (let i = 0; i < MAIL_RULES_MAX_ACTION_ATTEMPTS; i++) {
      await runMailRules(ACCOUNT, FOLDER, h.deps)
    }
    expect(attempts).toBe(MAIL_RULES_MAX_ACTION_ATTEMPTS)
    expect(h.captured).toHaveLength(1)

    // A restart drops the in-memory counters — which is the point: a dead IMAP
    // connection is exactly what restarting fixes, so the message deserves
    // another go rather than staying skipped forever.
    h.deps.actionAttempts.clear()
    h.state = { watermarkUid: 9, uidValidity: 1 }
    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(attempts).toBe(MAIL_RULES_MAX_ACTION_ATTEMPTS + 1)
  })

  it('clears the attempt counter once the message succeeds', async () => {
    let failFirst = true
    const h = harness({
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
      executeRuleAction: async (_a, _f, uid, action) => {
        if (failFirst) { failFirst = false; throw new Error('boom') }
        h.executed.push({ uid, action: action.type })
      },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)
    expect(h.deps.actionAttempts.size).toBe(1)

    await runMailRules(ACCOUNT, FOLDER, h.deps)
    expect(h.deps.actionAttempts.size).toBe(0)
  })
})

describe('runMailRules — an abnormal exit must not eat the remembered trigger (§2.86 iter3)', () => {
  const KEY = `${ACCOUNT}:${FOLDER}`

  it('keeps the trigger raised by the very sync whose UIDVALIDITY bump aborted the pass, and the next pass re-anchors', async () => {
    // The nastiest ordering: a sync publishes a new numbering space, that same
    // sync triggers a pass, the trigger lands on a busy key and is remembered —
    // and then the running pass aborts BECAUSE of that bump and consumed the
    // trigger on its way out. The re-anchor the trigger existed for would then
    // wait for an unrelated future trigger that may never come.
    const h = harness({ uids: [10, 11], state: { watermarkUid: 9, uidValidity: 1 } })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    h.deps.executeRuleAction = async (_a, _f, uid, action) => {
      await gate
      h.executed.push({ uid, action: action.type })
    }

    const first = runMailRules(ACCOUNT, FOLDER, h.deps)
    h.uidValidity = 2                                     // sync reassigned UIDs
    const second = await runMailRules(ACCOUNT, FOLDER, h.deps)   // ...and triggered a pass
    expect(second.skipped).toBe(true)
    expect(h.deps.pendingRerun.has(KEY)).toBe(true)

    release()
    const result = await first

    expect(result.aborted).toBe(true)
    expect(h.deps.inFlight.size).toBe(0)
    // The request survives: the pass that consumed it did not serve it.
    expect(h.deps.pendingRerun.has(KEY)).toBe(true)

    const third = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(third.baselined).toBe(true)
    expect(h.state).toEqual({ watermarkUid: 11, uidValidity: 2 })
    // Served, so now it is retired.
    expect(h.deps.pendingRerun.has(KEY)).toBe(false)
  })

  it('keeps the trigger when the pass stopped on a failed action', async () => {
    const h = harness({
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
      executeRuleAction: async () => { throw new Error('Connection not available') },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.deps.pendingRerun.has(KEY)).toBe(true)
  })

  it('keeps the trigger armed even when some messages in the pass were fully processed before the abort', async () => {
    // `served` gates whether the trigger is retired, and it must track the
    // WHOLE call's outcome (`!total.aborted`), not "did any useful work
    // happen". Real work landing before an abort — uid 10's watermark write —
    // must not be mistaken for the pass having served the request sitting in
    // pendingRerun.
    const h = harness({
      uids: [10, 11],
      state: { watermarkUid: 9, uidValidity: 1 },
      executeRuleAction: async (_a, _f, uid, action) => {
        if (uid === 11) throw new Error('Connection not available')
        h.executed.push({ uid, action: action.type })
      },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(true)
    expect(h.executed).toEqual([{ uid: 10, action: 'trash' }])
    expect(h.state?.watermarkUid).toBe(10)   // uid 10's work was persisted
    expect(h.deps.pendingRerun.has(KEY)).toBe(true)   // yet the request survives
  })

  it('keeps the trigger when the pass threw outright', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })
    h.deps.getUidsForRulesSince = () => { throw new Error('db gone') }

    await expect(runMailRules(ACCOUNT, FOLDER, h.deps)).rejects.toThrow('db gone')

    expect(h.deps.pendingRerun.has(KEY)).toBe(true)
    expect(h.deps.inFlight.size).toBe(0)
  })

  it('retires the trigger after a pass that completed normally', async () => {
    // The counter-case: re-arming must not be unconditional, or the marker
    // would never clear and would stop meaning anything.
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.aborted).toBe(false)
    expect(h.deps.pendingRerun.size).toBe(0)
  })
})

describe('runMailRules — resilience', () => {
  it('advances past a message that vanished between discovery and evaluation', async () => {
    const h = harness({ state: { watermarkUid: 9, uidValidity: 1 } })
    h.store.set(10, message())
    h.store.set(11, message())
    const realGet = h.deps.getMessageByUid
    h.deps.getMessageByUid = (a, f, uid) => (uid === 10 ? undefined : realGet(a, f, uid))

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result.evaluated).toBe(1)
    expect(h.state?.watermarkUid).toBe(11)
    expect(h.captured).toEqual([])
  })

  it('releases the in-flight slot when the pass throws', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })
    h.deps.getUidsForRulesSince = () => { throw new Error('db gone') }

    await expect(runMailRules(ACCOUNT, FOLDER, h.deps)).rejects.toThrow('db gone')
    expect(h.deps.inFlight.size).toBe(0)
  })
})

describe('runMailRules — no work', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a cheap no-op when nothing is above the watermark', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 10, uidValidity: 1 } })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(result).toEqual({ evaluated: 0, matched: 0, baselined: false, skipped: false, aborted: false })
    expect(h.watermarkWrites).toEqual([])
  })
})

describe('runMailRules — rules that cannot be justified (§2.162)', () => {
  beforeEach(() => vi.clearAllMocks())

  /**
   * Rule whose sole condition is on the given field, driving `type`.
   *
   * `move` gets a target folder: without one the rule is refused for its SHAPE
   * (§2.162), and these tests are about the policy verdict, not the shape one.
   */
  function ruleOn(field: string, type: string): MailRulesRunnerRule {
    return trashRule({
      conditions: JSON.stringify([{ field, op: 'equals', value: 'cp@mai.ru' }]),
      actions: JSON.stringify([type === 'move' ? { type, folder: 'Filed' } : { type }]),
    })
  }

  it('does not execute a destructive action gated on the legacy from field (AC6)', async () => {
    for (const type of ['move', 'trash', 'archive', 'mark_spam']) {
      const h = harness({
        rules: [ruleOn('from', type)],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, type).toEqual([])
      expect(h.logged, type).toEqual([])
      expect(result.matched, type).toBe(0)
      // The message is still accounted for: the watermark advances past it and
      // it reaches the AI-rules pipeline like any message no static rule matched.
      expect(h.state?.watermarkUid, type).toBe(10)
      expect(h.enqueuedForAi, type).toEqual([10])
    }
  })

  it('records the skip with the reason and the field, without the rule name (AC6)', async () => {
    const h = harness({
      rules: [ruleOn('from', 'trash')],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    const line = h.warnings.find(w => w.includes('rule-1'))
    expect(line).toContain('unverifiable_sender')
    expect(line).toContain('from')
    expect(line).toContain('trash')
    // Rule names are user-authored text and routinely carry addresses.
    expect(line).not.toContain('trash spam sender')
  })

  it('still executes mark_read and mark_starred on the legacy from field (AC7)', async () => {
    for (const type of ['mark_read', 'mark_starred']) {
      const h = harness({
        rules: [ruleOn('from', type)],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, type).toEqual([{ uid: 10, action: type }])
      expect(result.matched, type).toBe(1)
    }
  })

  it('does not execute a rule conditioned on cc, whatever the action', async () => {
    for (const type of ['trash', 'mark_read']) {
      const h = harness({
        rules: [ruleOn('cc', type)],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, type).toEqual([])
      expect(h.warnings.some(w => w.includes('unsupported_field')), type).toBe(true)
    }
  })

  it('refuses only the offending rule — siblings still run', async () => {
    const h = harness({
      rules: [
        ruleOn('from', 'trash'),
        trashRule({ id: 'rule-2', priority: 1, actions: JSON.stringify([{ type: 'mark_read' }]) }),
      ],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 10, action: 'mark_read' }])
    expect(result.matched).toBe(1)
  })

  it('does not execute a destructive action gated on the display name (from_name)', async () => {
    // The AI tool contract always claimed this was enforced; until §2.162's
    // review it was enforced by nothing but the wording of a prompt.
    for (const type of ['move', 'trash', 'archive', 'mark_spam']) {
      const h = harness({
        rules: [ruleOn('from_name', type)],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, type).toEqual([])
      expect(h.warnings.some(w => w.includes('unverifiable_sender')), type).toBe(true)
    }
  })

  it('still executes reversible actions gated on from_name', async () => {
    const h = harness({
      rules: [ruleOn('from_name', 'mark_read')],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })
    // The stored message has no display name of its own (from === fromAddr), so
    // match on the value the fixture does carry.
    h.store.set(10, { ...message(), from: 'Acme Support', fromAddr: 'billing@acme.test' })
    h.deps.listMailRules = () => [trashRule({
      conditions: JSON.stringify([{ field: 'from_name', op: 'equals', value: 'Acme Support' }]),
      actions: JSON.stringify([{ type: 'mark_read' }]),
    })]

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 10, action: 'mark_read' }])
    expect(result.matched).toBe(1)
  })

  it('drops a structurally broken stored rule instead of throwing on every message', async () => {
    // Syntactically valid JSON of the wrong shape. Before the shape check,
    // `parseRule` cast it through and `matchRule` threw on `.every`, which the
    // per-message catch counted as a failed action: retried, then abandoned
    // with a Sentry report — for a rule, not for a mail server problem.
    for (const conditions of ['{}', '[42]', '[{"op":"contains","value":"x"}]']) {
      const h = harness({
        rules: [trashRule({ conditions, actions: JSON.stringify([{ type: 'trash' }]) })],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, conditions).toEqual([])
      expect(h.captured, conditions).toEqual([])
      expect(result.aborted, conditions).toBe(false)
      // The message is not stuck: it advances and reaches the AI-rules queue.
      expect(h.state?.watermarkUid, conditions).toBe(10)
      expect(h.enqueuedForAi, conditions).toEqual([10])
    }
  })

  it('drops a rule whose actions half is not an array', async () => {
    const h = harness({
      rules: [trashRule({ actions: '{"type":"trash"}' })],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    expect(h.captured).toEqual([])
    expect(result.aborted).toBe(false)
  })

  it('drops a rule whose operator the engine has no branch for', async () => {
    // Such a rule matches nothing anyway; dropping it makes the fact visible in
    // the log instead of leaving the user with a filter that quietly does
    // nothing.
    const h = harness({
      rules: [trashRule({
        conditions: JSON.stringify([{ field: 'from_address', op: 'contain', value: 'cp@mai.ru' }]),
      })],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    expect(h.warnings.some(w => w.includes('malformed'))).toBe(true)
  })

  it('drops a rule whose action type the executor has no branch for, before it can be logged as applied', async () => {
    const h = harness({
      rules: [trashRule({ actions: JSON.stringify([{ type: 'delete' }]) })],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([])
    // The point of the finding: no rule_log row for an action nobody performed.
    expect(h.logged).toEqual([])
    expect(h.warnings.some(w => w.includes('malformed'))).toBe(true)
  })

  it('drops a move rule that names no target folder, before it can be logged as applied', async () => {
    for (const actions of ['[{"type":"move"}]', '[{"type":"move","folder":"  "}]']) {
      const h = harness({
        rules: [trashRule({ actions })],
        uids: [10],
        state: { watermarkUid: 9, uidValidity: 1 },
      })

      await runMailRules(ACCOUNT, FOLDER, h.deps)

      expect(h.executed, actions).toEqual([])
      // The finding: the executor moved nothing, and the row said "applied".
      expect(h.logged, actions).toEqual([])
      expect(h.warnings.some(w => w.includes('malformed')), actions).toBe(true)
    }
  })

  it('keeps a move rule with a target working', async () => {
    const h = harness({
      rules: [trashRule({ actions: JSON.stringify([{ type: 'move', folder: 'Filed' }]) })],
      uids: [10],
      state: { watermarkUid: 9, uidValidity: 1 },
    })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 10, action: 'move' }])
    expect(h.logged).toEqual([10])
    expect(result.matched).toBe(1)
  })

  it('keeps a well-formed destructive rule working', async () => {
    const h = harness({ uids: [10], state: { watermarkUid: 9, uidValidity: 1 } })

    const result = await runMailRules(ACCOUNT, FOLDER, h.deps)

    expect(h.executed).toEqual([{ uid: 10, action: 'trash' }])
    expect(result.matched).toBe(1)
  })
})
