import { describe, expect, it, vi } from 'vitest'

// `packages/net/config` (imported below for the real settings schema) pulls in
// `packages/db`, which opens the SQLite database at MODULE LOAD time. Under the
// CI `unit-tests` job that is fatal: better-sqlite3 is built for the Electron
// ABI by `postinstall`, vitest runs on system Node, and only `packages/db/**`
// is excluded from that job — a file here is not. Stubbing the one symbol
// `config.ts` actually imports keeps the schema binding (the point of the
// import) without dragging a native module into a pure unit test.
vi.mock('../../packages/db', () => ({
  deleteAccountData: vi.fn(),
}))

import {
  accumulatedStepCostUsd,
  budgetCeilingReached,
  createRequestBudgetGuard,
  normalizeStepTokens,
  resolveRequestBudgetUsd,
  usableStepTokens,
  createRequestSpendLedger,
  fabricationCapUsd,
  DEFAULT_MAX_BUDGET_PER_REQUEST_USD,
  type RequestStepLike,
} from './aiRequestBudget'
// The REAL settings schema — the source of truth this module's default mirrors.
import { settingsSchema } from '../../packages/net/config'

// §2.51.f2 — the per-request cost ceiling for the Vercel (non-Claude) agentic
// loop. This module is pure, so every branch is exercised without the SDK: the
// integration seam (`streamText({ stopWhen: [...] })` and the `notice` event) is
// covered in ai.test.ts.

describe('resolveRequestBudgetUsd', () => {
  it('falls back to the schema default (2 USD) when the setting is absent', () => {
    expect(resolveRequestBudgetUsd(undefined)).toBe(2)
  })

  // §2.51.f2 iteration 6 — `DEFAULT_MAX_BUDGET_PER_REQUEST_USD` is an INDEPENDENT
  // copy of the zod default (this module stays free of the config module's zod +
  // IO dependencies). An earlier comment claimed the two could not drift because
  // they "came from the same helper", which was false. This test is the actual
  // coupling: change either side and it fails.
  it('stays in sync with the aiMaxBudgetPerRequest default in the settings schema', () => {
    // Parse the FIELD, not the whole object: other settings have no defaults, so
    // `settingsSchema.parse({})` fails for reasons unrelated to this coupling.
    expect(DEFAULT_MAX_BUDGET_PER_REQUEST_USD)
      .toBe(settingsSchema.shape.aiMaxBudgetPerRequest.parse(undefined))
  })

  it('honours a configured positive ceiling', () => {
    expect(resolveRequestBudgetUsd(0.25)).toBe(0.25)
    expect(resolveRequestBudgetUsd(100)).toBe(100)
  })

  it('treats 0 and negatives as UNLIMITED (same `> 0` convention as the daily/monthly windows)', () => {
    expect(resolveRequestBudgetUsd(0)).toBeNull()
    expect(resolveRequestBudgetUsd(-1)).toBeNull()
  })

  it('treats a non-finite value as unlimited rather than enforcing NaN', () => {
    expect(resolveRequestBudgetUsd(Number.NaN)).toBeNull()
    expect(resolveRequestBudgetUsd(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

// §2.51.f2 fix-wave (Medium-2) — the ceiling guard and `streamOpenAiChat`'s
// request-scoped counters accumulate the SAME quantity, so they must agree on
// what a valid token count is. They previously disagreed (guard clamped,
// counters added raw), and a single malformed step could make the counters NaN
// while the guard stayed sane — silently disabling the notice, its metric and
// the usage-priced ledger settle. This helper is the single normalization both
// call.
describe('normalizeStepTokens', () => {
  it('passes a clean count through', () => {
    expect(normalizeStepTokens(1234)).toBe(1234)
    expect(normalizeStepTokens(0)).toBe(0)
  })

  it('floors a fractional count to a whole token', () => {
    expect(normalizeStepTokens(10.9)).toBe(10)
  })

  it('collapses missing, non-numeric, non-finite and negative counts to 0', () => {
    expect(normalizeStepTokens(undefined)).toBe(0)
    expect(normalizeStepTokens('500' as unknown as number)).toBe(0)
    expect(normalizeStepTokens(Number.NaN)).toBe(0)
    expect(normalizeStepTokens(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeStepTokens(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(normalizeStepTokens(-42)).toBe(0)
  })

  it('never returns a value that can poison a sum', () => {
    for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      const total = 100 + normalizeStepTokens(raw as number)
      expect(Number.isFinite(total)).toBe(true)
      expect(total).toBeGreaterThanOrEqual(100)
    }
  })
})

// §2.51.f2 iteration 3 (High-2) — the BILLING half of the same question.
// `normalizeStepTokens` answers "how much do we know was spent" (0 for garbage);
// `usableStepTokens` additionally answers "did we know at all" (null for
// garbage). Collapsing the second question into the first is what let an
// endpoint with a mangled `outputTokens` settle the ledger at the price of its
// input tokens alone — output for free, on every request.
describe('usableStepTokens', () => {
  it('returns a clean count as a number, including a genuine zero', () => {
    expect(usableStepTokens(1234)).toBe(1234)
    // 0 is a real measurement, NOT an absence — it must not read as unusable.
    expect(usableStepTokens(0)).toBe(0)
  })

  it('floors a fractional count', () => {
    expect(usableStepTokens(10.9)).toBe(10)
  })

  it('returns null for every unusable shape', () => {
    expect(usableStepTokens(undefined)).toBeNull()
    expect(usableStepTokens('500' as unknown as number)).toBeNull()
    expect(usableStepTokens(Number.NaN)).toBeNull()
    expect(usableStepTokens(Number.POSITIVE_INFINITY)).toBeNull()
    expect(usableStepTokens(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('treats a NEGATIVE count as unusable rather than clamping it to zero', () => {
    // Clamping is right for measurement (normalizeStepTokens does exactly that),
    // but "-20000 output tokens" is not evidence the output was free — it is
    // evidence the endpoint's usage cannot be trusted, i.e. the fail-closed case.
    expect(usableStepTokens(-20_000)).toBeNull()
    expect(normalizeStepTokens(-20_000)).toBe(0)
  })

  it('agrees with normalizeStepTokens on every usable value', () => {
    for (const raw of [0, 1, 999, 10.9]) {
      expect(usableStepTokens(raw)).toBe(normalizeStepTokens(raw))
    }
  })
})

describe('accumulatedStepCostUsd', () => {
  it('prices the summed token counts through the shared core rate table', () => {
    const steps: RequestStepLike[] = [
      { usage: { inputTokens: 1000, outputTokens: 1000 } },
      { usage: { inputTokens: 1000, outputTokens: 1000 } },
    ]
    // gpt-4o: $0.005 / 1k in, $0.015 / 1k out → 2k in + 2k out = $0.04.
    expect(accumulatedStepCostUsd('gpt-4o', steps)).toBeCloseTo(0.04, 10)
  })

  it('prices a pricier model higher for identical usage (no second rate table)', () => {
    const steps: RequestStepLike[] = [{ usage: { inputTokens: 1000, outputTokens: 1000 } }]
    expect(accumulatedStepCostUsd('gpt-4o', steps))
      .toBeGreaterThan(accumulatedStepCostUsd('gpt-4o-mini', steps))
  })

  it('returns 0 for an empty step list', () => {
    expect(accumulatedStepCostUsd('gpt-4o', [])).toBe(0)
  })

  it('skips steps with missing or partial usage instead of poisoning the total', () => {
    const steps: RequestStepLike[] = [
      {},
      { usage: undefined },
      { usage: { inputTokens: undefined, outputTokens: 1000 } },
    ]
    // Only the 1000 output tokens are priced: $0.015 on gpt-4o.
    expect(accumulatedStepCostUsd('gpt-4o', steps)).toBeCloseTo(0.015, 10)
  })

  it('ignores non-finite and negative token counts (never NaN, never negative)', () => {
    const steps: RequestStepLike[] = [
      { usage: { inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY } },
      { usage: { inputTokens: -5000, outputTokens: 1000 } },
    ]
    const cost = accumulatedStepCostUsd('gpt-4o', steps)
    expect(Number.isFinite(cost)).toBe(true)
    expect(cost).toBeCloseTo(0.015, 10)
  })

  it('prices an unrecognized model id through the conservative default rate table instead of throwing', () => {
    // `modelRates()` in packages/core/aiRules.ts falls back to a flat
    // $0.001/$0.003 per-1k rate for any model string it does not recognize —
    // this guard must inherit that fallback rather than special-case unknown
    // models (a crash here would leave a request unbounded rather than priced
    // conservatively).
    const steps: RequestStepLike[] = [{ usage: { inputTokens: 1000, outputTokens: 1000 } }]
    const cost = accumulatedStepCostUsd('some-future-provider-model-v7', steps)
    expect(cost).toBeCloseTo(0.001 + 0.003, 10)
  })
})

describe('createRequestBudgetGuard', () => {
  const cheapStep: RequestStepLike = { usage: { inputTokens: 10, outputTokens: 10 } }
  const expensiveStep: RequestStepLike = { usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }

  it('does not stop while the accumulated cost stays under the ceiling', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 2)
    expect(guard.stopWhen({ steps: [cheapStep, cheapStep] })).toBe(false)
    expect(guard.tripped()).toBe(false)
    expect(guard.spentUsd()).toBeGreaterThan(0)
    expect(guard.spentUsd()).toBeLessThan(2)
  })

  it('stops the loop once the accumulated cost reaches the ceiling', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 2)
    expect(guard.stopWhen({ steps: [expensiveStep] })).toBe(true)
    expect(guard.tripped()).toBe(true)
    expect(guard.spentUsd()).toBeGreaterThanOrEqual(2)
  })

  it('stops on exact equality with the ceiling (no headroom left for another step)', () => {
    // gpt-4o: 1000 output tokens = $0.015 exactly.
    const guard = createRequestBudgetGuard('gpt-4o', 0.015)
    expect(guard.stopWhen({ steps: [{ usage: { inputTokens: 0, outputTokens: 1000 } }] })).toBe(true)
    expect(guard.tripped()).toBe(true)
  })

  it('stays tripped on later evaluations (the stop decision is not reversible)', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 2)
    guard.stopWhen({ steps: [expensiveStep] })
    expect(guard.stopWhen({ steps: [cheapStep] })).toBe(true)
  })

  it('never stops and never prices when the ceiling is disabled (null)', () => {
    const guard = createRequestBudgetGuard('gpt-4o', null)
    expect(guard.stopWhen({ steps: [expensiveStep, expensiveStep] })).toBe(false)
    expect(guard.tripped()).toBe(false)
    expect(guard.spentUsd()).toBe(0)
    expect(guard.limitUsd).toBeNull()
  })

  it('exposes stopWhen as a bound value usable as a bare SDK stop condition', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 2)
    const bare = guard.stopWhen
    expect(bare({ steps: [expensiveStep] })).toBe(true)
    expect(guard.tripped()).toBe(true)
  })

  it('does not stop a provider that reports no usage at all (the ledger cap still applies)', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 0.0001)
    expect(guard.stopWhen({ steps: [{}, { usage: undefined }] })).toBe(false)
    expect(guard.tripped()).toBe(false)
  })

  // §2.51.f2 fix-wave — the ceiling is scoped to the REQUEST. A retry restarts
  // the SDK step list, so the guard is recreated; without carrying the spend of
  // the earlier attempts the effective cap would be `limit × attempts`.
  describe('carried spend across retries', () => {
    it('counts the carried baseline toward the ceiling instead of restarting at zero', () => {
      // gpt-4o: 1000 output tokens = $0.015. One such step alone stays under a
      // $0.02 ceiling — but not when $0.015 was already spent by attempt 1.
      const step: RequestStepLike = { usage: { inputTokens: 0, outputTokens: 1000 } }

      const withoutCarry = createRequestBudgetGuard('gpt-4o', 0.02)
      expect(withoutCarry.stopWhen({ steps: [step] })).toBe(false)

      const withCarry = createRequestBudgetGuard('gpt-4o', 0.02, 0.015)
      expect(withCarry.stopWhen({ steps: [step] })).toBe(true)
      expect(withCarry.spentUsd()).toBeCloseTo(0.03, 6)
    })

    it('reports request-scoped spend (carry + this attempt) even before any step', () => {
      const guard = createRequestBudgetGuard('gpt-4o', 2, 0.5)
      expect(guard.spentUsd()).toBe(0.5)
      expect(guard.tripped()).toBe(false)
    })

    it('is a BASELINE, not a pre-tripped flag — a retry is never aborted before its first step', () => {
      // Carry alone already exceeds the ceiling. The guard must still report
      // "keep going" until the SDK has actually completed a step, because
      // `stopWhen` is only evaluated at a step boundary; pre-tripping would let a
      // retry return nothing at all.
      const guard = createRequestBudgetGuard('gpt-4o', 1, 5)
      expect(guard.tripped()).toBe(false)
      // ...and it stops at the very first step boundary of that retry.
      expect(guard.stopWhen({ steps: [{ usage: { inputTokens: 1, outputTokens: 1 } }] })).toBe(true)
    })

    it('ignores a non-finite or negative carry rather than poisoning the comparison', () => {
      const cheap: RequestStepLike = { usage: { inputTokens: 10, outputTokens: 10 } }
      const nan = createRequestBudgetGuard('gpt-4o', 2, Number.NaN)
      expect(nan.stopWhen({ steps: [cheap] })).toBe(false)
      expect(Number.isFinite(nan.spentUsd())).toBe(true)

      const negative = createRequestBudgetGuard('gpt-4o', 2, -100)
      expect(negative.stopWhen({ steps: [cheap] })).toBe(false)
      expect(negative.spentUsd()).toBeGreaterThan(0)
    })

    it('ignores the carry entirely when the ceiling is disabled', () => {
      const guard = createRequestBudgetGuard('gpt-4o', null, 999)
      expect(guard.stopWhen({ steps: [expensiveStep] })).toBe(false)
      expect(guard.tripped()).toBe(false)
    })
  })
})

// §2.51.f2 fix-wave — the caller must classify "stopped for cost" from the SPEND,
// not from whether the guard's predicate happened to run: `stopWhen` takes an
// array and the SDK does not promise to evaluate every condition.
describe('budgetCeilingReached', () => {
  it('never reports a ceiling when the ceiling is disabled', () => {
    expect(budgetCeilingReached(null, 1000)).toBe(false)
  })

  it('reports the ceiling at or above the limit and not below it', () => {
    expect(budgetCeilingReached(2, 1.999)).toBe(false)
    expect(budgetCeilingReached(2, 2)).toBe(true)
    expect(budgetCeilingReached(2, 2.5)).toBe(true)
  })

  it('is order-independent: the same verdict the guard reaches, without the guard', () => {
    const guard = createRequestBudgetGuard('gpt-4o', 0.015)
    const step: RequestStepLike = { usage: { inputTokens: 0, outputTokens: 1000 } }
    // The guard's predicate is what would be short-circuited away by an earlier
    // stop condition; the pure predicate agrees with it on the same numbers.
    expect(guard.stopWhen({ steps: [step] })).toBe(true)
    expect(budgetCeilingReached(0.015, accumulatedStepCostUsd('gpt-4o', [step]))).toBe(true)
  })

  it('treats a non-finite spend as "not reached" rather than stopping on NaN', () => {
    expect(budgetCeilingReached(2, Number.NaN)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────
// §2.51.f2 iteration 4 — the request spend ledger.
//
// This object now owns every money question on the Vercel chat path, so its
// rules are pinned here in isolation: what a provider call costs when it cannot
// be priced, what counts as a call, and the idempotency of the single
// finalization point that `streamOpenAiChat` calls from a `finally`.
// ──────────────────────────────────────────────────────────────────────

describe('createRequestSpendLedger', () => {
  // gpt-4o-mini: $0.00015 / 1k in, $0.0006 / 1k out.
  const MODEL = 'gpt-4o-mini'
  const FLOOR = 0.05
  // Per-request ceiling in force for most cases below. High enough that the
  // fabrication cap is not the thing under test — the cap has its own suite.
  const CEILING = 10

  it('reports nothing for a request that never recorded anything', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
    expect(ledger.billedUsd()).toBeUndefined()
    expect(ledger.measuredUsd()).toBe(0)
    expect(ledger.stepCount()).toBe(0)
    expect(ledger.isAmbiguous()).toBe(false)
  })

  it('prices a fully reported step from real tokens (no floor inflation)', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
    ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    ledger.finalizeAttempt()
    // $0.15 in + $0.60 out — a measurement, charged verbatim.
    expect(ledger.billedUsd()).toBeCloseTo(0.75, 10)
    expect(ledger.measuredUsd()).toBeCloseTo(0.75, 10)
  })

  it('charges a cheap measured request its real (sub-floor) price', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
    ledger.noteStep({ inputTokens: 1_000, outputTokens: 1_000 })
    ledger.finalizeAttempt()
    const billed = ledger.billedUsd() as number
    expect(billed).toBeGreaterThan(0)
    // The floor is a fallback for the unknown, NOT a minimum on a real price.
    expect(billed).toBeLessThan(FLOOR)
  })

  // The billing unit is the PROVIDER CALL. Applying one floor to the whole
  // request let a second, entirely unpriceable call ride along for free on the
  // back of a first call that happened to be measurable.
  describe('one floor per unpriceable provider call', () => {
    it.each([
      ['absent usage entirely', undefined],
      ['NaN output', { inputTokens: 1_000, outputTokens: Number.NaN }],
      ['negative output', { inputTokens: 1_000, outputTokens: -5 }],
      ['non-number output', { inputTokens: 1_000, outputTokens: '5' as unknown as number }],
      ['absent output half', { inputTokens: 1_000 }],
      ['unusable input half', { inputTokens: Number.NaN, outputTokens: 1_000 }],
    ])('charges exactly one floor for a single step with %s', (_label, usage) => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep(usage)
      ledger.finalizeAttempt()
      // The floor REPLACES the partial price rather than adding to it: the floor
      // is a conservative estimate for the WHOLE call and already dominates the
      // half we could read.
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('adds one floor per unpriceable step — three bad calls cost three floors', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep(undefined)
      ledger.noteStep({ inputTokens: 100, outputTokens: Number.NaN })
      ledger.noteStep({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 100 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR * 3, 10)
      expect(ledger.stepCount()).toBe(3)
    })

    it('mixes measured and unpriceable calls additively', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) // $0.75
      ledger.noteStep(undefined)                                          // + floor
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })

    it('keeps the usable half in the MEASURED number without charging it twice', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: Number.NaN })
      ledger.finalizeAttempt()
      // Measurement keeps the $0.15 of input tokens the provider did report…
      expect(ledger.measuredUsd()).toBeCloseTo(0.15, 10)
      // …while billing charges the conservative whole-call floor instead.
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
      expect(ledger.measuredTokens()).toEqual({ inputTokens: 1_000_000, outputTokens: 0 })
    })
  })

  // An attempt that generated and died before ANY step boundary is a completed
  // provider call nobody will ever price. It is the one case that counts toward
  // the ceiling as well, because that is what stops a retry storm from spending
  // unbounded money under a per-request limit.
  describe('an attempt that generated without reaching a step boundary', () => {
    it('charges one floor, and only at finalization', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      // Before finalization the verdict is not yet reachable — the attempt might
      // still complete a step.
      expect(ledger.billedUsd()).toBeUndefined()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('counts toward the CEILING as well (retry-storm brake)', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
      expect(ledger.measuredUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('accumulates one floor per such attempt', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      for (let i = 0; i < 3; i++) {
        ledger.noteGeneratedOutput()
        ledger.finalizeAttempt()
      }
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR * 3, 10)
    })

    it('charges nothing for an attempt that produced no output at all', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.finalizeAttempt()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeUndefined()
      expect(ledger.measuredUsd()).toBe(0)
    })

    it('does NOT double-charge an attempt that both generated and completed a step', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75, 10)
    })

    // §2.51.f2 iteration 7 — a step boundary ENDS one provider call and starts the
    // next. Tracking "did this attempt ever reach a step" instead of "is the
    // in-flight call unaccounted" lost every call after the first: once any step
    // had completed, a following call that streamed output and then died charged
    // nothing, and the outer settle could not rescue it because a positive
    // measured cost suppresses that fallback.
    it('charges the UNFINISHED call that follows a completed step', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) // call 1: priced
      ledger.noteGeneratedOutput()                                        // call 2: started
      ledger.finalizeAttempt()                                            // call 2: died
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })

    it('charges only ONE floor for the unfinished call, however much it streamed', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.noteGeneratedOutput()
      ledger.noteGeneratedOutput()
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })

    it('charges nothing extra when the attempt ends cleanly on a step boundary', () => {
      // Output, then the step that prices it, then the attempt ends. The call was
      // accounted at its boundary; there is no unfinished call to charge for.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.noteGeneratedOutput()
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(1.5, 10)
    })

    it('does not double-charge an unfinished call that ALSO ended ambiguously', () => {
      // Still the same in-flight call, described by two facts.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.noteGeneratedOutput()
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })
  })

  // `finalizeAttempt` is called from a `finally`, and a defensive caller may end
  // up calling it more than once for the same attempt. It must be safe.
  describe('finalizeAttempt is idempotent', () => {
    it('does not re-charge a generated-but-unmeasured attempt on repeated calls', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
      ledger.finalizeAttempt()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('starts a fresh attempt as soon as new evidence is recorded', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
      // No explicit "begin": recording evidence opens the next attempt, so a
      // caller cannot forget to open one and silently lose its charge.
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR * 2, 10)
    })
  })

  // §2.51.f2 iteration 6 — this suite previously pinned the OPPOSITE rule
  // ("ambiguity alone is not a charge — the caller decides"). That was the defect:
  // it left ambiguity as a second state machine outside the ledger, and because
  // the caller's fallback is suppressed as soon as any positive number exists, a
  // silently retried 503 followed by a cheap success charged only the success.
  // An ambiguous attempt IS a provider call whose price we will never learn.
  describe('an ambiguous attempt is charged as an unpriceable provider call', () => {
    it('costs one floor and still reports the sticky verdict', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      expect(ledger.isAmbiguous()).toBe(false)
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      expect(ledger.isAmbiguous()).toBe(true)
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('charges one floor PER ambiguous attempt', () => {
      // Three silently retried 5xx attempts are three possibly-paid calls.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      for (let i = 0; i < 3; i++) {
        ledger.markAmbiguous()
        ledger.finalizeAttempt()
      }
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR * 3, 10)
    })

    it('adds its floor on top of spend that WAS measured', () => {
      // The reported scenario: an ambiguous attempt, then a measured success. The
      // measured number must not swallow the ambiguous call's charge.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })

    it('does not double-charge an attempt that generated AND ended ambiguously', () => {
      // Both facts describe the SAME in-flight call.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteGeneratedOutput()
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('charges a further floor when ambiguity follows a completed priced step', () => {
      // A step completed and was priced; the NEXT call then 5xx'd. That failed
      // call is additional, and its price is unknowable.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + FLOOR, 10)
    })

    it('stays under the fabrication cap like every other invented charge', () => {
      const ceiling = 0.12
      const ledger = createRequestSpendLedger(MODEL, FLOOR, ceiling)
      for (let i = 0; i < 10; i++) {
        ledger.markAmbiguous()
        ledger.finalizeAttempt()
      }
      expect(ledger.billedUsd()).toBeCloseTo(ceiling, 10)
    })

    it('fabricates nothing against a self-hosted endpoint (zero floor)', () => {
      const ledger = createRequestSpendLedger(MODEL, 0, CEILING)
      ledger.markAmbiguous()
      ledger.finalizeAttempt()
      expect(ledger.isAmbiguous()).toBe(true)
      expect(ledger.billedUsd()).toBeUndefined()
    })
  })

  it('degrades to measurement-only when no usable floor is available', () => {
    // A caller that cannot compute a floor must not have garbage charged on its
    // behalf; the priced part still counts.
    for (const badFloor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ledger = createRequestSpendLedger(MODEL, badFloor, CEILING)
      ledger.noteStep(undefined)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75, 10)
    }
  })

  it('returns the normalized input tokens of the step it recorded', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, CEILING)
    // The caller feeds this straight into its context-window safety net, so the
    // guard and the accounting can never disagree about what the provider said.
    expect(ledger.noteStep({ inputTokens: 10.9, outputTokens: 5 })).toBe(10)
    expect(ledger.noteStep({ inputTokens: Number.NaN, outputTokens: 5 })).toBe(0)
    expect(ledger.noteStep(undefined)).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// §2.51.f2 iteration 5 — the fabrication cap.
//
// A floor per unpriceable provider call is right in the small and wrong in the
// large: a long agentic loop against an endpoint that never reports usage (a
// local Ollama-style server is exactly that) invents money for a request whose
// real cost may be zero, and a handful of those would exhaust the daily cap on a
// feature that cost nothing. Inventing an over-count is not a fix for an
// under-count — either way the number stops meaning "what you actually spent".
// ──────────────────────────────────────────────────────────────────────

describe('fabricationCapUsd', () => {
  it('uses the configured per-request ceiling', () => {
    expect(fabricationCapUsd(2)).toBe(2)
    expect(fabricationCapUsd(0.25)).toBe(0.25)
  })

  it('falls back to the schema default of the same setting when the ceiling is disabled', () => {
    // Disabling the ceiling removes ENFORCEMENT, not the yardstick — and
    // "unlimited" is not a number we may invent against.
    //
    // Asserted against the REAL parsed schema default, not against
    // `resolveRequestBudgetUsd(undefined)`: comparing the helper with itself
    // proves only that the module is self-consistent and would happily pass while
    // both had drifted away from the product's actual default.
    expect(fabricationCapUsd(null)).toBe(settingsSchema.shape.aiMaxBudgetPerRequest.parse(undefined))
  })

  it('treats a corrupted ceiling as disabled rather than enforcing garbage', () => {
    expect(fabricationCapUsd(Number.NaN)).toBe(resolveRequestBudgetUsd(undefined))
    expect(fabricationCapUsd(-1)).toBe(resolveRequestBudgetUsd(undefined))
    expect(fabricationCapUsd(0)).toBe(resolveRequestBudgetUsd(undefined))
  })
})

describe('createRequestSpendLedger — fabricated charges are bounded by the request ceiling', () => {
  const MODEL = 'gpt-4o-mini'
  const FLOOR = 0.05

  // The scenario that made this ship-blocking.
  it('a ten-step loop with no usage never bills more than the per-request ceiling', () => {
    const ceiling = 0.2
    const ledger = createRequestSpendLedger(MODEL, FLOOR, ceiling)
    for (let i = 0; i < 10; i++) ledger.noteStep(undefined)
    ledger.finalizeAttempt()

    // Uncapped this would be 10 x $0.05 = $0.50 for a request that may have cost
    // nothing at all.
    expect(ledger.billedUsd()).toBeCloseTo(ceiling, 10)
  })

  it('bills the honest sum while it is still under the ceiling', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, 10)
    for (let i = 0; i < 3; i++) ledger.noteStep(undefined)
    ledger.finalizeAttempt()
    // The cap is a bound, not a target: three unpriceable calls cost three floors.
    expect(ledger.billedUsd()).toBeCloseTo(FLOOR * 3, 10)
  })

  it('caps dead-attempt floors too, not just unpriceable steps', () => {
    const ceiling = 0.08
    const ledger = createRequestSpendLedger(MODEL, FLOOR, ceiling)
    for (let i = 0; i < 4; i++) {
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
    }
    expect(ledger.billedUsd()).toBeCloseTo(ceiling, 10)
  })

  it('bounds the ceiling seed the same way, so the two numbers agree', () => {
    const ceiling = 0.08
    const ledger = createRequestSpendLedger(MODEL, FLOOR, ceiling)
    for (let i = 0; i < 4; i++) {
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
    }
    // Capping the measured side costs the retry-storm brake nothing: reaching the
    // cap means reaching the ceiling, and `budgetCeilingReached` uses `>=`.
    expect(ledger.measuredUsd()).toBeCloseTo(ceiling, 10)
    expect(budgetCeilingReached(ceiling, ledger.measuredUsd())).toBe(true)
  })

  // A ceiling smaller than one floor is a legitimate configuration, and the
  // answer is NOT "then a provider call costs less than a floor". The ceiling is
  // evaluated at step boundaries and provably cannot prevent the first call, the
  // admission already reserved a whole floor for that call, and a cap that
  // lowered the price of calls already made would turn `aiMaxBudgetPerRequest`
  // into a spend bypass (set it to $0.0001 and every unpriceable call costs
  // $0.0001). The cap bounds ACCUMULATION only.
  describe('a ceiling smaller than one floor', () => {
    it('still charges one whole floor for a single unpriceable call', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, 0.01)
      ledger.noteStep(undefined)
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('still bounds accumulation at that one floor', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, 0.01)
      for (let i = 0; i < 20; i++) ledger.noteStep(undefined)
      ledger.finalizeAttempt()
      // Twenty unpriceable calls, one floor charged — bounded, and never below
      // the estimate of the call that certainly happened.
      expect(ledger.billedUsd()).toBeCloseTo(FLOOR, 10)
    })

    it('never settles below the reservation the admission already held', () => {
      // The floor IS `conservativeReservationUsd(model)`, so settling under it
      // would rewrite our own hold downward for a call that occurred.
      for (const ceiling of [0.0001, 0.01, null]) {
        const ledger = createRequestSpendLedger(MODEL, FLOOR, ceiling)
        ledger.noteGeneratedOutput()
        ledger.finalizeAttempt()
        expect(ledger.billedUsd() as number).toBeGreaterThanOrEqual(FLOOR)
      }
    })
  })

  it('applies the fallback bound when the ceiling is disabled', () => {
    const ledger = createRequestSpendLedger(MODEL, FLOOR, null)
    // 100 unpriceable calls would fabricate $5 — more than the default daily cap
    // — from a single request.
    for (let i = 0; i < 100; i++) ledger.noteStep(undefined)
    ledger.finalizeAttempt()
    expect(ledger.billedUsd()).toBeCloseTo(resolveRequestBudgetUsd(undefined) as number, 10)
  })

  // Edge case 3: only INVENTED money is bounded.
  describe('real measured cost is never trimmed', () => {
    it('bills the full measured amount even when it exceeds the ceiling', () => {
      // $0.75 of honestly reported tokens against a $0.10 ceiling. The ceiling
      // already ended the loop; the ledger records what happened, not what was
      // permitted.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, 0.1)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75, 10)
    })

    it('adds capped floors ON TOP of an over-ceiling measured cost', () => {
      // Measured $0.75 + 6 unpriceable calls ($0.30 uncapped) against a $0.10
      // ceiling: the measured part is whole, the fabricated part is bounded.
      const ledger = createRequestSpendLedger(MODEL, FLOOR, 0.1)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      for (let i = 0; i < 6; i++) ledger.noteStep(undefined)
      ledger.finalizeAttempt()
      expect(ledger.billedUsd()).toBeCloseTo(0.75 + 0.1, 10)
    })

    it('never reports a charge below what was actually measured', () => {
      const ledger = createRequestSpendLedger(MODEL, FLOOR, 0.001)
      ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
      ledger.noteStep(undefined)
      ledger.finalizeAttempt()
      expect(ledger.billedUsd() as number).toBeGreaterThanOrEqual(0.75)
    })
  })
})

// §2.51.f2 iteration 6 — a self-hosted endpoint is passed a floor of 0, which is
// how "do not fabricate" is expressed to the ledger. The decision of WHICH
// endpoints qualify lives in ai.ts (`isLocalInferenceEndpoint`); this pins the
// ledger's half of the contract: no floor means no invented money, while real
// reported usage is still counted.
describe('createRequestSpendLedger — a zero floor fabricates nothing', () => {
  const MODEL = 'gpt-4o-mini'

  it('bills nothing for a long loop of unpriceable calls', () => {
    const ledger = createRequestSpendLedger(MODEL, 0, 2)
    for (let i = 0; i < 10; i++) ledger.noteStep(undefined)
    ledger.finalizeAttempt()
    expect(ledger.billedUsd()).toBeUndefined()
    expect(ledger.measuredUsd()).toBe(0)
  })

  it('bills nothing for attempts that generated and died unmeasured', () => {
    const ledger = createRequestSpendLedger(MODEL, 0, 2)
    for (let i = 0; i < 3; i++) {
      ledger.noteGeneratedOutput()
      ledger.finalizeAttempt()
    }
    expect(ledger.billedUsd()).toBeUndefined()
  })

  it('still counts REAL reported usage honestly', () => {
    // A local server that does report usage is measured like any other.
    const ledger = createRequestSpendLedger(MODEL, 0, 2)
    ledger.noteStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    ledger.noteStep(undefined)
    ledger.finalizeAttempt()
    expect(ledger.billedUsd()).toBeCloseTo(0.75, 10)
  })
})
