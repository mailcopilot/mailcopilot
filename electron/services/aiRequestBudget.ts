// ──────────────────────────────────────────────────────────────────────
// aiRequestBudget.ts — §2.51.f2 request-scoped cost accounting for the Vercel AI
// SDK (non-Claude) agentic loop: the per-request ceiling AND the spend ledger
// that decides what the daily/monthly cap is charged.
//
// WHY BOTH LIVE HERE (§2.51.f2 iteration 4)
// They were not one module before, and that was the defect. `streamOpenAiChat`
// carried its own counters, degraded-usage flag and per-attempt evidence, while
// `aiChat` carried `generationStarted` / `resultSeen` / `costUsd` / ambiguity and
// a settle fallback. Two state machines describing the SAME money, kept in sync
// by hand at each exit path — so every newly discovered exit path (a retry that
// throws, a consumer `break` that calls `return()` on the generator) was another
// way to lose spend. Three review iterations each found another one.
//
// {@link createRequestSpendLedger} replaces that with ONE owned object:
//   - evidence is RECORDED as it happens (generated output, completed steps);
//   - {@link RequestSpendLedger.finalizeAttempt} is the SINGLE finalization point
//     and is called from a `finally`, so it is reached on success, on throw, on
//     abort and on generator `return()` alike;
//   - the ledger — not the caller — decides what is measurable and what is
//     billable.
// A new exit path added later cannot silently drop spend: it either goes through
// the `finally` (accounted) or it does not leave the loop at all.
//
// WHAT THIS IS
// The `aiMaxBudgetPerRequest` setting ("maximum cost per request") used to be
// honoured on ONE provider path only: the Claude Agent SDK reads it as
// `maxBudgetUsd` (electron/services/ai.ts `makeQueryOptions`) and terminates the
// agentic loop once the accumulated ACTUAL cost of the request reaches the
// ceiling. On the `openai-api` path — which runs the same multi-step tool loop
// through `streamText` — nothing read the setting at all, so the slider existed
// in Settings with no effect for two providers out of three. This module gives
// that path the same semantics.
//
// WHAT IT IS NOT (scope fence — §4.16)
// This is a ceiling on ACCUMULATED ACTUAL cost, evaluated BETWEEN steps of an
// already-admitted request. It is NOT a pre-flight reservation of a computed
// upper bound for the call (that is §4.16, deliberately out of scope), and it is
// NOT the daily/monthly cap (that is the atomic ledger admission in ai.ts —
// `admitBudgetedCall`). Like the Claude SDK's `maxBudgetUsd`, it cannot stop a
// single in-flight step: the earliest it can act is at the step boundary, so a
// one-step request always runs to completion regardless of the ceiling.
//
// PRICING
// Cost is priced by the SINGLE shared rate table in `packages/core/aiRules.ts`
// (`estimateAiRuleCostUsd`) — the same table the AI Rules pipeline, the ledger
// reconcile path and `estimateCostUsd` in ai.ts use. No second pricing copy on a
// money path (a duplicate would drift silently and mis-enforce the ceiling).
//
// The module is deliberately free of Electron / db / SDK imports so it stays
// unit-testable in isolation and keeps the ai.ts hotspot from growing another
// block of accounting logic (CLAUDE.md §5 hotspot policy).
// ──────────────────────────────────────────────────────────────────────

import { estimateAiRuleCostUsd } from '../../packages/core'

/**
 * Structural mirror of the token usage the AI SDK reports per step
 * (`LanguageModelUsage`). Declared structurally rather than imported from `ai`
 * so this module carries no SDK dependency; the fields we read are the two
 * stable ones the SDK has always reported, and both may be `undefined` when a
 * provider omits usage.
 */
export interface RequestStepUsageLike {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
}

/** Structural mirror of the AI SDK `StepResult` fields this module reads. */
export interface RequestStepLike {
  usage?: RequestStepUsageLike | undefined
}

/**
 * Normalize the configured per-request ceiling into "enforced limit" or
 * "unlimited" (`null`).
 *
 * A missing setting falls back to {@link DEFAULT_MAX_BUDGET_PER_REQUEST_USD},
 * which is also the default the Claude path passes as `maxBudgetUsd`, so both
 * providers behave identically for a user who never touched the slider.
 *
 * A non-positive or non-finite value means UNLIMITED, matching the identical
 * `limitUsd > 0` convention every other budget window in this codebase uses
 * (`budgetWindows` / `admitAiReservation`). The Settings input allows 0, and
 * interpreting 0 as "stop the loop immediately" would brick the AI panel from a
 * numeric field with no warning; "0 = no per-request ceiling" is the reading
 * consistent with the daily/monthly windows. The daily/monthly caps still apply
 * either way — turning this ceiling off never means unmetered spend.
 */
/**
 * Fallback per-request ceiling for a caller that supplies no value at all.
 *
 * INDEPENDENT COPY — say so rather than imply otherwise. This mirrors
 * `aiMaxBudgetPerRequest: z.number()...default(2)` in packages/net/config.ts but
 * is NOT derived from it: importing the settings schema would pull zod and the
 * config module's IO into a module that is deliberately dependency-light and
 * unit-testable in isolation. An earlier comment here claimed the two "cannot
 * drift because they come from the same helper", which was simply untrue.
 *
 * The coupling is enforced mechanically instead: `aiRequestBudget.test.ts` parses
 * the real `settingsSchema` and asserts its default equals this constant, so a
 * change on either side fails a test rather than silently diverging.
 *
 * In practice this constant is rarely the operative number: `getSettings()`
 * returns schema-parsed settings, so the ceiling normally arrives already
 * defaulted. It matters for callers that pass nothing — notably the fabrication
 * bound when the user disabled the ceiling.
 */
export const DEFAULT_MAX_BUDGET_PER_REQUEST_USD = 2

export function resolveRequestBudgetUsd(limit: number | undefined): number | null {
  const value = typeof limit === 'number' ? limit : DEFAULT_MAX_BUDGET_PER_REQUEST_USD
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Coerce ONE provider-reported step token count into a clean, finite,
 * non-negative integer. `undefined`, a non-number, NaN, ±Infinity and negative
 * values all collapse to 0.
 *
 * §2.51.f2 fix-wave (Medium-2) — this is deliberately shared between the two
 * places that accumulate step usage: the ceiling guard here and the
 * request-scoped counters in `streamOpenAiChat`. They previously normalized
 * DIFFERENTLY (the guard clamped, the counters added the raw value), so a single
 * malformed step could make the guard see a sane number while the request
 * counters went NaN — which silently disabled the ceiling notice, its metric,
 * and the usage-priced ledger settle all at once. Two accumulators of the same
 * quantity must not disagree about what a valid token count is.
 *
 * Chosen over `normalizeChatUsage` in ai.ts (which rejects a PAIR outright when
 * either half is malformed) because these are streaming per-step increments: one
 * bad step should not discard the tokens every other step legitimately reported.
 */
export function normalizeStepTokens(raw: number | undefined): number {
  return usableStepTokens(raw) ?? 0
}

/**
 * The same coercion as {@link normalizeStepTokens}, but it DISTINGUISHES "the
 * provider said zero" from "the provider said something we cannot use":
 * a clean count comes back as a number, anything unusable comes back as `null`.
 *
 * §2.51.f2 fix-wave (High-2) — this distinction is load-bearing for money.
 * Collapsing an unusable half to 0 and then billing the sum means an endpoint
 * that always mangles `outputTokens` gets its output for free: the ledger
 * REPLACES the conservative reservation with the price of the input tokens
 * alone, on every request. The measurement paths (ceiling, logs) legitimately
 * keep the usable half — they answer "how much do we KNOW was spent". The
 * billing path must additionally know that something was UNKNOWN, so it can
 * fall back to the fail-closed floor instead of a confidently wrong small
 * number. `null` is that signal.
 *
 * An ABSENT half counts as unusable, matching `normalizeChatUsage` in ai.ts,
 * which rejects a usage pair outright when either half is not a number and lets
 * the caller settle at the floor.
 *
 * A NEGATIVE count is unusable too, not merely clamped. Clamping it to 0 is what
 * the measurement path wants (`normalizeStepTokens`), but for billing "the
 * provider said -20000 output tokens" is not evidence that the output was free —
 * it is evidence that this endpoint's usage cannot be trusted, which is exactly
 * when the fail-closed floor must apply.
 */
export function usableStepTokens(raw: number | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.floor(raw)
}

/**
 * Accumulated ACTUAL cost of the steps completed so far, priced from the
 * provider-reported token counts through the shared core rate table.
 *
 * Steps with no usable usage contribute 0 here — deliberately, and unlike the
 * ledger path, which fails closed to a conservative reservation floor. The
 * difference is intentional: the ledger enforces a hard money cap where an
 * unpriceable call must still count, whereas this ceiling only decides whether
 * to run ANOTHER step of a request the ledger already admitted and will still
 * charge. Charging an invented floor here would truncate legitimate requests on
 * providers that simply do not report usage, while the real cap (daily/monthly)
 * remains fully enforced. Returns a finite number, never NaN/Infinity
 * (`estimateAiRuleCostUsd` rejects non-finite inputs and overflowed results).
 *
 * USER-VISIBLE CONSEQUENCE — state it plainly rather than leave it implied:
 * against an OpenAI-compatible endpoint that never reports token usage (some
 * self-hosted / proxy front-ends omit the `usage` object entirely), accumulated
 * cost stays 0 for every step, so THE PER-REQUEST CEILING NEVER FIRES on that
 * endpoint — the request runs until the turn cap instead. The daily and monthly
 * ledger caps still apply there (they fail closed to a model-aware floor), so
 * spend remains bounded; it is only this one ceiling that is inert. Same
 * limitation shape as an unpriceable model id, and the reason the ledger — not
 * this guard — is the load-bearing cap.
 */
export function accumulatedStepCostUsd(
  model: string,
  steps: readonly RequestStepLike[],
): number {
  let inputTokens = 0
  let outputTokens = 0
  for (const step of steps) {
    const usage = step?.usage
    if (!usage) continue
    inputTokens += normalizeStepTokens(usage.inputTokens)
    outputTokens += normalizeStepTokens(usage.outputTokens)
  }
  const cost = estimateAiRuleCostUsd(model, { inputTokens, outputTokens })
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0
}

/**
 * Has the request-scoped spend reached the ceiling?
 *
 * Extracted as a pure predicate so the guard AND the caller's post-stream
 * classification apply the IDENTICAL rule to the IDENTICAL number. The caller
 * must not infer "stopped for cost" from whether the guard's predicate happened
 * to run: `stopWhen` takes an ARRAY of conditions and the SDK only promises to
 * stop when one of them holds — not to evaluate all of them. If it
 * short-circuits on `stepCountIs`, the guard never observes the final step, so
 * "did the guard trip" is an artefact of predicate ORDER, not of what the
 * request actually spent. Classifying from the accumulated spend instead is
 * order-independent.
 *
 * `>=` (not `>`): once accumulated spend has REACHED the ceiling there is no
 * headroom left for another step, so running one more would necessarily
 * overshoot. Erring toward stopping is the safe side for a cost ceiling.
 */
export function budgetCeilingReached(limitUsd: number | null, spentUsd: number): boolean {
  if (limitUsd === null) return false
  return Number.isFinite(spentUsd) && spentUsd >= limitUsd
}

/**
 * Per-request ceiling guard for one `streamText` call.
 *
 * `stopWhen` is an AI SDK `StopCondition`-shaped predicate: the SDK evaluates it
 * after every step and ends the loop when it returns true. Passing it alongside
 * `stepCountIs(maxTurns)` gives "stop at N turns OR at the cost ceiling,
 * whichever comes first" — the idiomatic composition for this SDK version
 * (`stopWhen` accepts an array of conditions and stops on the first that fires).
 *
 * RETRIES. The ceiling is scoped to the REQUEST, not to one network attempt. A
 * retry restarts the SDK's `steps` array from zero, so a fresh guard is created
 * per attempt — but it is seeded with `carriedSpentUsd`, the cost already
 * accumulated by the previous attempts. Without that seed each retry would hand
 * the request a full fresh ceiling and the effective cap would be
 * `limit × (STREAM_MAX_RETRIES + 1)`.
 *
 * The seed is a BASELINE, not a pre-tripped flag: `stopWhen` is only ever
 * evaluated by the SDK AFTER a step completes, so seeding cannot abort a retry
 * before its first step (the concern that motivated the per-attempt guard in the
 * first place). A retry whose carried spend is already at the ceiling therefore
 * runs exactly one more step and then stops — the same "one step of overshoot"
 * bound the ceiling has within a single attempt.
 */
export interface RequestBudgetGuard {
  /** Configured ceiling in USD, or `null` when the ceiling is disabled. */
  readonly limitUsd: number | null
  /** AI SDK stop condition. Safe to pass as a bare value (bound closure). */
  readonly stopWhen: (options: { steps: readonly RequestStepLike[] }) => boolean
  /**
   * True once the ceiling fired — i.e. this guard's own condition returned true.
   *
   * DIAGNOSTIC ONLY. Do NOT use it to tell the user why a request stopped: it is
   * false whenever the SDK short-circuited on an earlier stop condition and
   * never evaluated the guard, which makes it a function of predicate ORDER.
   * User-facing classification goes through {@link budgetCeilingReached} on the
   * accumulated spend.
   */
  tripped(): boolean
  /**
   * Request-scoped spend observed at the last evaluated step boundary: the
   * carried baseline from earlier attempts plus this attempt's steps. Same
   * order-dependence caveat as {@link RequestBudgetGuard.tripped}.
   */
  spentUsd(): number
}

export function createRequestBudgetGuard(
  model: string,
  limitUsd: number | null,
  carriedSpentUsd = 0,
): RequestBudgetGuard {
  // Defensive: a non-finite / negative carry (an unpriceable earlier attempt)
  // must not poison the comparison — treat it as "nothing carried".
  const carried = Number.isFinite(carriedSpentUsd) && carriedSpentUsd > 0 ? carriedSpentUsd : 0
  let tripped = false
  let spentUsd = carried

  const stopWhen = ({ steps }: { steps: readonly RequestStepLike[] }): boolean => {
    if (limitUsd === null) return false
    spentUsd = carried + accumulatedStepCostUsd(model, steps)
    if (budgetCeilingReached(limitUsd, spentUsd)) tripped = true
    return tripped
  }

  return {
    limitUsd,
    stopWhen,
    tripped: () => tripped,
    spentUsd: () => spentUsd,
  }
}

// ──────────────────────────────────────────────────────────────────────
// Request spend ledger (§2.51.f2 iteration 4)
// ──────────────────────────────────────────────────────────────────────

/**
 * The running cost record of ONE chat request, across every network attempt and
 * every agentic step inside those attempts.
 *
 * THE PROBLEM IT SOLVES. Cost used to be reconstructed at each exit path by the
 * caller: counters here, a degraded-usage flag there, a per-attempt floor added
 * in the `catch`, an evidence handle published in two of the three places a
 * request can end. Every review iteration found one more exit that skipped a
 * step of that bookkeeping — most recently `return()`, which an async generator
 * takes straight from its `yield` into `finally`, bypassing `catch` entirely.
 * The defect was never the individual miss; it was that "spend is accounted"
 * depended on the caller remembering to do it at N different places.
 *
 * THE MODEL. Callers only RECORD what happened ({@link noteGeneratedOutput},
 * {@link noteStep}, {@link markAmbiguous}) and call {@link finalizeAttempt} from
 * a `finally`. Every question about money — what is measurable, what is billable,
 * what an unpriceable call costs — is answered here, once.
 *
 * BILLING UNIT: THE PROVIDER CALL. Each completed agentic step is one paid API
 * call, so an unpriceable step costs one conservative floor — not "the request
 * gets a floor if anything anywhere was unpriceable". Applying the floor once to
 * the aggregate let a request with a real measured cost of $0.01 and a second,
 * entirely unpriced provider call settle at $0.01: the second call was free
 * because the first one happened to be measurable.
 *
 * MEASURED vs BILLED, and why they are not the same number:
 *   - {@link measuredUsd} answers "how much do we KNOW was spent". It prices only
 *     tokens the provider actually reported. It drives the per-request CEILING,
 *     which must not truncate a legitimate request just because an endpoint
 *     reports usage badly (see `accumulatedStepCostUsd`).
 *   - {@link billedUsd} answers "how much may we charge the cap". It adds a
 *     conservative floor for every provider call we could not price, because
 *     "the provider did not tell us the output size" is not evidence that the
 *     output was free.
 * The one deliberate crossover: a call that ENDED WITHOUT ANY STEP BOUNDARY (an
 * attempt that generated and then died) counts toward BOTH. It is a completed,
 * unmeasurable call, and letting it count against the ceiling is what stops a
 * retry storm from spending unbounded money under a per-request limit.
 */
export interface RequestSpendLedger {
  /**
   * The provider emitted billable output in the CURRENT attempt — generated text
   * or a tool call. Proof that this attempt cost money even if it never reaches a
   * step boundary that prices it.
   */
  noteGeneratedOutput(): void
  /**
   * One agentic step completed = one paid provider call. `usage` is whatever the
   * provider reported for it, including `undefined` when it reported nothing at
   * all (which is itself an unpriceable call, not a free one).
   *
   * Returns the usable INPUT token count recorded for this step, so the caller's
   * context-window safety net measures the same normalized number the accounting
   * did instead of re-deriving it from the raw event.
   */
  noteStep(usage: RequestStepUsageLike | undefined): number
  /**
   * Close the CURRENT attempt. MUST be called from a `finally` so it is reached
   * on success, on throw, on abort AND on generator `return()`.
   *
   * Idempotent: a second call with no intervening evidence is a no-op, so a
   * caller that finalizes defensively in more than one place cannot double-charge.
   * This is what converts "generated but never reported usage" into a charge —
   * the only moment at which that verdict can be reached.
   */
  finalizeAttempt(): void
  /**
   * The CURRENT attempt ended in a state where billing cannot be ruled out even
   * without generation evidence — today: the endpoint answered 5xx, or the
   * transport died after dispatch.
   *
   * §2.51.f2 iteration 6 — this CHARGES, it does not merely flag. An ambiguous
   * attempt is a provider call that happened and whose price we will never
   * learn, which is exactly the definition of an unpriceable call, so it costs
   * one floor under the same fabrication cap as any other. Recording it as a
   * bare boolean left ambiguity as a second state machine outside this ledger:
   * a silently retried 503 followed by a $0.006 success settled $0.006, because
   * the caller's fallback is suppressed as soon as ANY positive number exists —
   * so the possibly-paid first call vanished. Three retried 503s collapsed into
   * one floor for the same reason.
   *
   * Sticky at the REQUEST level for {@link isAmbiguous} (the caller still needs
   * the verdict to decide that spend occurred at all), per-ATTEMPT for the
   * charge.
   */
  markAmbiguous(): void
  /** Has an ambiguous verdict been recorded anywhere in this request? */
  isAmbiguous(): boolean
  /** Completed provider calls so far — a PII-free aggregate for telemetry. */
  stepCount(): number
  /** Normalized token totals actually reported by the provider (for logging). */
  measuredTokens(): { inputTokens: number; outputTokens: number }
  /** See the MEASURED vs BILLED note above. Always a finite number. */
  measuredUsd(): number
  /**
   * See the MEASURED vs BILLED note above. `undefined` only when NOTHING is
   * known — no priced tokens and no unpriceable call — so the caller keeps its
   * own "unpriceable completion → floor" fallback for that case.
   */
  billedUsd(): number | undefined
}

/**
 * How much FABRICATED money one request may accumulate (§2.51.f2 iteration 5).
 *
 * THE PROBLEM. A floor per unpriceable provider call is right in the small — an
 * unmeasurable call is not a free call — but it compounds: a ten-step agentic
 * loop against an endpoint that never reports usage fabricates ten floors
 * ($0.50 at the flat minimum) for a request whose REAL cost may be zero. A
 * self-hosted / local OpenAI-compatible endpoint (Ollama and friends typically
 * omit `usage` entirely) is exactly that case, and on the default $5 daily cap a
 * dozen such requests would lock the user out of a feature that cost nothing.
 * Fixing an under-count by inventing an over-count is not a fix: either way the
 * number in the UI stops meaning "what you actually spent".
 *
 * THE RULE. Fabricated charges for one request never exceed the per-request cost
 * ceiling the user configured. That statement is the user's own: "one request
 * may cost at most $X". Charging more than $X for one request would contradict
 * the very setting this task made enforceable, and the REAL cost cannot exceed
 * it either, because the ceiling stops the agentic loop.
 *
 * THE THREE EDGE CASES, decided explicitly:
 *
 * 1. CEILING DISABLED (`null`, i.e. the user set 0). Disabling the ceiling
 *    removes ENFORCEMENT — it does not license unbounded fabrication, and
 *    "unlimited" is not a number we may invent against. We fall back to
 *    `resolveRequestBudgetUsd(undefined)`: the schema default this same setting
 *    carries for everyone who never touched it. It is derived from the same
 *    setting through the same helper rather than being a fresh magic constant,
 *    so it cannot drift away from the product's own idea of a normal request.
 *
 * 2. SCOPE OF THE CAP: the FABRICATED component only, never the whole charge.
 *    Capping the total would silently trim REAL measured cost, which is the
 *    under-count this whole task exists to remove (and edge case 3 forbids it
 *    outright). So the charge is `measuredPrice + min(floors, cap)`.
 *
 *    Does capping floors reopen the under-count? Bounded, and knowingly: it can
 *    hide spend only on a provider that BOTH omits usage AND genuinely charges
 *    more per request than the user's own per-request ceiling — a request we
 *    could not have priced or stopped anyway, since the ceiling guard has
 *    nothing to measure there. The daily and monthly caps still count every
 *    capped charge. That residual is strictly smaller than the alternative,
 *    which systematically overcharges every legitimate zero-cost request.
 *
 * 3. MEASURED COST IS NEVER TRIMMED. A provider that honestly reports $3 against
 *    a $2 ceiling settles at $3: the ceiling already ended the loop, and the
 *    ledger records what happened rather than what was permitted. Only invented
 *    money is bounded, because only invented money can be wrong in our favour.
 *
 * ONE FLOOR IS INDIVISIBLE (the ceiling-below-a-floor case). A ceiling smaller
 * than a single floor — say $0.01 against a $0.05 floor — is a legitimate
 * configuration, and the caller applies `Math.max(cap, floor)` so such a request
 * still charges one whole floor. The cap bounds ACCUMULATION, never the first
 * call, for three reasons:
 *   - this ceiling provably cannot prevent that call. It is evaluated at STEP
 *     BOUNDARIES, so a one-step request always runs to completion regardless
 *     (stated in this module's header). Charging less than our own estimate of a
 *     call we know happened would be inventing a discount, not avoiding a
 *     fabrication;
 *   - the daily/monthly admission ALREADY reserved a full floor for that call.
 *     Settling below it would rewrite the hold DOWN for a call that occurred —
 *     an under-count against our own ledger;
 *   - otherwise `aiMaxBudgetPerRequest` becomes a spend bypass: set it to
 *     $0.0001 and every unpriceable call costs $0.0001. A cost cap whose value
 *     lowers what past calls cost is not a cap.
 * The bound still holds where it matters: that request pays ONE floor no matter
 * how many unpriceable steps follow.
 */
export function fabricationCapUsd(requestCeilingUsd: number | null): number {
  if (requestCeilingUsd !== null && Number.isFinite(requestCeilingUsd) && requestCeilingUsd > 0) {
    return requestCeilingUsd
  }
  // Edge case 1 — the schema default of the same setting, resolved through the
  // same helper (never a second hard-coded number).
  return resolveRequestBudgetUsd(undefined) ?? 0
}

/**
 * @param model         Model id, priced through the shared core rate table.
 * @param callFloorUsd  Conservative charge for ONE provider call we cannot price
 *                      (the caller passes `conservativeReservationUsd(model)` —
 *                      the same floor the daily/monthly admission reserves, so a
 *                      call that cannot be measured is charged exactly what it
 *                      was admitted for). A non-finite / non-positive value is
 *                      treated as "no floor available", which degrades to
 *                      measurement-only rather than charging garbage.
 * @param requestCeilingUsd  The per-request cost ceiling in force
 *                      (`resolveRequestBudgetUsd(settings.aiMaxBudgetPerRequest)`),
 *                      or `null` when the user disabled it. Bounds how much
 *                      FABRICATED money one request may accumulate — see
 *                      {@link fabricationCapUsd}.
 */
export function createRequestSpendLedger(
  model: string,
  callFloorUsd: number,
  requestCeilingUsd: number | null,
): RequestSpendLedger {
  const floor = Number.isFinite(callFloorUsd) && callFloorUsd > 0 ? callFloorUsd : 0
  // ONE FLOOR IS INDIVISIBLE — see `fabricationCapUsd`. The cap bounds how many
  // floors may ACCUMULATE, but never shrinks the charge for a single provider
  // call below the estimate the admission already reserved for it.
  const floorCap = Math.max(fabricationCapUsd(requestCeilingUsd), floor)

  // Tokens the provider REPORTED, keeping a usable half even when its partner is
  // garbage — measurement wants every real number it can get.
  let measuredInputTokens = 0
  let measuredOutputTokens = 0
  // Tokens from steps that were FULLY priceable. Billing uses only these, because
  // a partially reported step is charged its floor instead (which dominates the
  // partial price and does not pretend the missing half was zero).
  let pricedInputTokens = 0
  let pricedOutputTokens = 0
  // Completed provider calls whose usage we could not price. Each costs one floor.
  let unpricedCalls = 0
  // Provider calls that ended WITHOUT a step boundary — the in-flight call an
  // attempt was making when it died. Each is also one unpriceable call, but it
  // additionally counts toward the ceiling (see the crossover note on
  // RequestSpendLedger).
  let unmeasuredAttempts = 0
  let stepCount = 0
  let ambiguous = false

  // `attemptOpen` is the idempotency latch for finalizeAttempt: recording any
  // evidence opens the attempt, finalizing closes it.
  let attemptOpen = false
  let attemptAmbiguous = false
  // §2.51.f2 iteration 7 — CALL-scoped, not attempt-scoped. Did the provider call
  // that is CURRENTLY in flight produce billable output? A step boundary ends one
  // call and starts the next, so this resets there.
  //
  // The previous shape tracked "did this ATTEMPT ever reach a step" and asked
  // `generated && !hadStep` at finalization. That silently dropped the second
  // call of a multi-step attempt: once any step had completed, a NEXT call that
  // streamed text and then died (abort / ECONNRESET / consumer `return()`) found
  // the flag still true and charged nothing — and the outer settle could not
  // rescue it either, because a positive measured cost suppresses that fallback.
  // The billing unit is the provider CALL, so the flag has to live in call scope.
  let openCallGenerated = false

  const openAttempt = (): void => { attemptOpen = true }

  return {
    noteGeneratedOutput() {
      openAttempt()
      openCallGenerated = true
    },

    noteStep(usage) {
      openAttempt()
      stepCount++
      // This step boundary CLOSES the call that was in flight and accounts for it
      // below, so whatever that call generated is now paid for. Any output seen
      // after this point belongs to the NEXT call — which is exactly the
      // distinction that was missing when this flag was attempt-scoped.
      openCallGenerated = false

      const inputTokens = usableStepTokens(usage?.inputTokens)
      const outputTokens = usableStepTokens(usage?.outputTokens)
      // Measurement keeps whatever half is real.
      measuredInputTokens += inputTokens ?? 0
      measuredOutputTokens += outputTokens ?? 0

      if (inputTokens === null || outputTokens === null) {
        // Unpriceable call — including the "no usage object at all" case, which
        // an `if (usage)` guard used to skip entirely, making a provider that
        // reports nothing the cheapest one to use.
        unpricedCalls++
      } else {
        pricedInputTokens += inputTokens
        pricedOutputTokens += outputTokens
      }
      return inputTokens ?? 0
    },

    finalizeAttempt() {
      if (!attemptOpen) return
      // The attempt ended while a provider call was still in flight. Charge ONE
      // floor for that call when either kind of evidence says it happened:
      //   - it had already produced output (`openCallGenerated`), or
      //   - the attempt ended ambiguously (5xx / post-dispatch transport failure).
      // Deliberately not additive: both describe the SAME in-flight call, so an
      // attempt that generated and then 5xx'd is one call, not two. Calls that
      // reached a step boundary were already accounted there, and the flag reset
      // in `noteStep` is what keeps this about the UNFINISHED call only.
      if (attemptAmbiguous || openCallGenerated) {
        unmeasuredAttempts++
      }
      attemptOpen = false
      attemptAmbiguous = false
      openCallGenerated = false
    },

    markAmbiguous() {
      openAttempt()
      ambiguous = true
      attemptAmbiguous = true
    },
    isAmbiguous: () => ambiguous,
    stepCount: () => stepCount,
    measuredTokens: () => ({
      inputTokens: measuredInputTokens,
      outputTokens: measuredOutputTokens,
    }),

    measuredUsd() {
      const priced = estimateAiRuleCostUsd(model, {
        inputTokens: measuredInputTokens,
        outputTokens: measuredOutputTokens,
      })
      const measured = typeof priced === 'number' && Number.isFinite(priced) ? priced : 0
      // The same fabrication cap as `billedUsd`, so the two numbers cannot tell
      // different stories about the same invented money. It costs the retry-storm
      // brake nothing: the cap EQUALS the ceiling, and `budgetCeilingReached`
      // compares with `>=`, so a request whose fabricated total reaches the cap
      // has by definition reached the ceiling and stops.
      return measured + Math.min(unmeasuredAttempts * floor, floorCap)
    },

    billedUsd() {
      const priced = estimateAiRuleCostUsd(model, {
        inputTokens: pricedInputTokens,
        outputTokens: pricedOutputTokens,
      })
      const pricedUsd = typeof priced === 'number' && Number.isFinite(priced) ? priced : 0
      const floors = (unpricedCalls + unmeasuredAttempts) * floor
      if (pricedUsd === 0 && floors === 0) return undefined
      // The cap applies to the FABRICATED term only (see `fabricationCapUsd`):
      // `pricedUsd` is what the provider actually reported and is added whole,
      // so an honest $3 against a $2 ceiling still settles at $3.
      return pricedUsd + Math.min(floors, floorCap)
    },
  }
}
