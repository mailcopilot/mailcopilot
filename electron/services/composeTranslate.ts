// ──────────────────────────────────────────────────────────────────────────
// composeTranslate.ts — §3.3 B6 part 2, the DRAFT side.
//
// Part 1 (`aiTranslate.ts`) translates a message the user is READING. This
// module translates a draft the user is WRITING, and suggests which language to
// write it in. It is a separate file rather than another 400 lines in
// `aiTranslate.ts` (1.6k lines) or in `main.ts` — CLAUDE.md §5 hotspot policy —
// and it reuses part 1's contract wholesale instead of restating it: the same
// sixteen-code enum, the same system prompt builder, the same input cap, the
// same completeness rule, the same six refusal reasons, the same opt-in.
//
// ## The two things this module does, in one line each
//
//   1. TRANSLATE THE DRAFT, on demand, into a language the user names. Never
//      automatically — not on window open, not when the suggestion appears, not
//      when the user changes it. One request per press of the button.
//   2. SUGGEST a target language for a reply, from the language of the message
//      being replied to. A suggestion, not a decision: it pre-fills the picker
//      and starts nothing.
//
// ## What is deliberately NOT here, and why
//
//   - NO CACHE. `ai_translations` is keyed on the hash of the SOURCE TEXT, and
//     a draft is edited between every request — a hit would be rare, and each
//     miss would write a durable row holding the user's unsent writing for the
//     account's cache lifetime. Part 1's cache is untouched: this module neither
//     reads it nor writes it, and `AI_TRANSLATION_CONTRACT_VERSION` does not
//     move, so no cached reading-side answer is retired by this feature.
//   - NO SOURCE LANGUAGE. The instruction names only the target
//     (`buildTranslateSystemPrompt`), so the draft's own language is not an
//     input to the translation. Nothing detects it and nothing reports it.
//   - NO ENFORCEMENT ANYWHERE. The language a correspondent reads is not a fact
//     this process owns (CLAUDE.md §5 "who owns the truth"), so the suggestion
//     only ever suggests, and a draft is never blocked, flagged or auto-changed
//     because of it.
//
// ## Security invariants preserved here (CLAUDE.md §5 AI/MCP)
//
//   - wrapUntrusted(): the draft text is boundary-wrapped (canonical
//     packages/core primitive, which also neutralizes forged markers) BEFORE it
//     reaches the model. No draft content enters the prompt outside the markers.
//   - THE RENDERER NEVER BUILDS THE INSTRUCTION. `targetLang` is a member of a
//     closed sixteen-value enum, looked up in a fixed code → English-name table;
//     the only strings in the system prompt are literals from this repository.
//     There is no free-text field on the channel at all beyond the draft itself.
//   - §2.78 boundary, enforced SERVER-SIDE: the received text is re-split with
//     `splitComposeBody()` and only the own-text part is prompted. What comes
//     back is `joinComposeBody(split, translated)`, so a quote, forward banner
//     or signature inside the payload is restored byte-for-byte. The honest
//     limit (§2.173): that split is a best-effort read of flat text, so an
//     unrecognized quoting style is treated as own text and IS translated.
//   - Structured refusals, never throws: every failure mode is a value in
//     `TranslateDraftResult`, and an unexpected dependency throw is mapped to
//     `provider_error` so the IPC promise never rejects.
//   - §2.51 atomic, fail-closed budget admission: reserve BEFORE the provider
//     call, settle with the actual cost after, release ONLY on a provably
//     unbilled outcome; an ambiguous post-dispatch failure keeps the floor.
//   - Exactly ONE span per request that got as far as SELECTING a provider, and
//     exactly ONE audit row per request that actually reached one — including
//     the unexpected-throw path (§3.3.B4.f2). A refusal that never left the
//     machine writes no audit row (§3.3.B6.f1); a request that died before any
//     provider was selected writes NEITHER (§3.3.B6.f2), which is what the
//     `ai.translate.draft` disclosure states in the schema and on the six
//     telemetry pages.
//   - PII-free telemetry: aggregates only. The draft, the translation, the
//     recipients, the subject, the SUGGESTED language and whether the target
//     came from a suggestion never reach a span, a counter, a log line or
//     Sentry.
//   - Read-only: nothing here writes to the draft, the send queue or any
//     destructive path. The result is a proposal the user applies explicitly.
// ──────────────────────────────────────────────────────────────────────────

import {
  joinComposeBody,
  splitComposeBody,
  wrapUntrusted,
  estimateAiRuleCostUsd,
  nullUsageReservationUsd,
} from '../../packages/core'
// Imported BY PATH, not through the `packages/core` barrel: `language.ts` is
// the franc-facing module and the barrel is bundled into the renderer. Same
// discipline as `aiTranslate.ts`.
import {
  LANGUAGE_DETECTION_MAX_INPUT_CHARS,
  detectTextLanguage,
  languageCodeFromIso6393,
  type LanguageDetection,
  type TrigramScorer,
} from '../../packages/core/language'
import { appendAiActionLog, getMessageByUid, type AiCostReservation } from '../../packages/db'
import { getSettings } from '../../packages/net/config'
import {
  AI_CHAT_SIMPLE_MAX_OUTPUT_TOKENS,
  admitBudgetedCall,
  aiChatSimpleOutcome,
  isLocalInferenceEndpoint,
  releaseReservationNoSpend,
  selectSummaryProvider,
  settleReservationUsd,
  type AiChatSimpleOutcome,
  type AiProvider,
} from './ai'
import {
  TRANSLATE_INPUT_CHAR_CAP,
  buildTranslateSystemPrompt,
  isIncompleteCompletion,
  normalizeTranslationOutput,
  resolveTrigramScorer,
  type TranslateAdmission,
  type TranslateChatOutcome,
  type TranslateChatResult,
  type TranslateReservation,
} from './aiTranslate'
import { startMetricSpan } from '../metrics'
import { captureException } from '../sentry'
import { createLogger } from '../logger'
import type {
  TranslateDraftRefusalReason,
  TranslateDraftRequest,
  TranslateDraftResult,
  TranslateLanguageCode,
} from '@mailcopilot/types'

const log = createLogger('ComposeTranslate')

/**
 * How long `compose:getInit` / the `compose:init` send will wait for the
 * suggestion before giving up and delivering `null`.
 *
 * A CEILING ON A WAIT, NOT ON THE WORK — and the distinction is load-bearing
 * enough that this docblock got it wrong once (§3.3.B6.f2). An earlier version
 * claimed the work behind the deadline was "bounded by construction" and that
 * the only slow part was paging in franc's 180-language table. It is not what a
 * timer can promise: the detection pass is SYNCHRONOUS, so a `setTimeout` set
 * before it cannot fire during it. Whatever the pass costs, the main process
 * pays in full, deadline or no deadline; expiring only means we stop waiting
 * for a promise, never that we stopped someone's computation.
 *
 * What actually bounds the work is the INPUT CAP at the detector
 * (`LANGUAGE_DETECTION_MAX_INPUT_CHARS`, and the slice at the call site below),
 * measured at ~16 ms worst case. This constant exists for the other half: the
 * detector still has to be resolved (`import('franc')`) and the row still has
 * to come out of SQLite, and the compose window opening is a user-visible
 * action that must not wait on an advisory caption.
 *
 * The direction of failure is the whole point: expiring costs the SUGGESTION
 * and nothing else. The window opens, the draft is there, the target picker is
 * simply empty until the user names a language — which is the same state a
 * forward or a new message is in, and the state this field is `null` in far more
 * often than not. Nothing retries, and nothing arrives late: a second delivery
 * would mean the picker changing under the user's hands after they had started
 * reading it.
 */
export const COMPOSE_SUGGESTION_WAIT_MS = 250

/**
 * A pending suggestion: the promise `ui:openCompose` starts, and both delivery
 * paths later settle. `null` means "there was nothing to detect" (no reply ref,
 * or the opt-in is off) and settles instantly.
 */
export type PendingTargetLangSuggestion = Promise<TranslateLanguageCode | null> | null

// ──────────────────────────────────────────────────────────────────────────
// Part A — the suggestion
// ──────────────────────────────────────────────────────────────────────────

/** Injected collaborators for the suggestion. Every side effect is a
 *  dependency, so a test can assert that an opted-out account is never read out
 *  of the cache and that the detector is never handed renderer text. */
export interface SuggestTargetLangDeps {
  /** Per-account translate opt-in, DEFAULT OFF. Wired to `aiTranslateEnabled`. */
  isEnabledForAccount: (accountId: number) => boolean
  /**
   * Canonical message text from the LOCAL CACHE, by (accountId, folder, uid) —
   * the same read the reading-side translation uses. The ONLY source of text
   * for detection: the renderer never feeds the detector on any path.
   */
  getMessageText: (accountId: number, folder: string, uid: number) => string | null
  /** Local trigram detection. Advisory; see packages/core/language.ts. NEVER
   *  handed more than `LANGUAGE_DETECTION_MAX_INPUT_CHARS` characters — the
   *  pass is synchronous and quadratic in the worst shape (§3.3.B6.f2). */
  detectLanguage: (text: string) => LanguageDetection
  /** Structured logger. Never receives message content OR the detected code. */
  log: { error: (msg: string, err?: unknown) => void }
}

/**
 * Suggest the language a reply is probably meant to be written in.
 *
 * ## We do not guess — "we could not tell" is a first-class answer
 *
 * Every uncertain path returns `null`, and they are not distinguished because
 * the interface does the same thing in all of them: leave the picker empty.
 *
 *   - no `replyRef` at all — a forward or a brand-new message has no
 *     correspondent whose language we could have read;
 *   - the opt-in is OFF for that account — an opted-out mailbox does not get its
 *     message text read out of the cache and run through a detector on this path
 *     any more than on the reading path;
 *   - no cached row, or the body has not been downloaded yet;
 *   - too little script text, or two candidates too close together — the
 *     EXISTING thresholds in `detectTextLanguage`
 *     (`LANGUAGE_DETECTION_MIN_SCRIPT_CHARS`, `LANGUAGE_DETECTION_MIN_MARGIN`).
 *     No second confidence threshold is introduced here: a caption on a
 *     translation and a pre-filled picker are the same question — "is the
 *     detector sure enough to say this out loud" — and two answers to it would
 *     drift apart the first time either moved;
 *   - a language outside the sixteen we offer as targets.
 *
 * ## It suggests, and it starts nothing
 *
 * The return value pre-fills a picker. It triggers no translation, spends
 * nothing, writes nothing and is never persisted — see the `suggestedTargetLang`
 * docblock on `ComposeInit` for the ownership argument (the language a
 * correspondent reads is not a fact this process owns).
 *
 * Never throws: the cache read and the detector are injected, i.e. someone
 * else's code, and a suggestion is not worth failing a window open for.
 */
export function suggestReplyTargetLang(
  deps: SuggestTargetLangDeps,
  ref: { accountId: number; folder: string; uid: number } | null | undefined,
): TranslateLanguageCode | null {
  try {
    if (!ref) return null
    // The opt-in gate is FIRST, for the reason it is first on the reading path:
    // an opted-out account must not have its message text read out of the cache
    // for an AI feature at all, not even for a local computation.
    if (!deps.isEnabledForAccount(ref.accountId)) return null
    const text = deps.getMessageText(ref.accountId, ref.folder, ref.uid)
    if (typeof text !== 'string' || text.trim().length === 0) return null
    // A SLICE, NOT A REFUSAL, and it is not optional (§3.3.B6.f2). What comes
    // back from the cache is a whole message body — `messages.body_text` holds
    // up to 200 000 characters — and the detector is a SYNCHRONOUS quadratic
    // pass on the main process. The reading path never had this problem because
    // it refuses above `TRANSLATE_INPUT_CHAR_CAP` before detecting; this path
    // must not refuse, because a suggestion is advisory and the size gate needs
    // only 80 script characters, so the head of the message carries the answer.
    //
    // `detectTextLanguage` applies the same cap itself — this is the second
    // half of the same rule, at the boundary where UNTRUSTED cached text meets
    // an INJECTED detector, so the bound holds for whatever detector is wired
    // in rather than only for the one we ship.
    const detection = deps.detectLanguage(
      text.length > LANGUAGE_DETECTION_MAX_INPUT_CHARS
        ? text.slice(0, LANGUAGE_DETECTION_MAX_INPUT_CHARS)
        : text,
    )
    // Both "the detector would not commit" and "it named something our sixteen
    // codes have no member for" collapse to the same absent suggestion.
    return detection.ok ? languageCodeFromIso6393(detection.iso6393) : null
  } catch (err) {
    // NOTE what is logged: a marker, never the ref, never the text, never a
    // language code. See `recordSpan` on why the suggested code leaves no trace.
    deps.log.error('compose translate: suggestion failed — opening without one', err)
    return null
  }
}

/**
 * Wait for a pending suggestion, at most {@link COMPOSE_SUGGESTION_WAIT_MS}.
 *
 * Lives here rather than in `main.ts` (hotspot) and is exported so both delivery
 * paths — `compose:getInit` for a window being created, the `compose:init` send
 * for a window being reused — go through the SAME helper. Two implementations
 * of "wait a bit, then give up" would be two chances for one of them to wait
 * forever, and the reuse path is the one where that would freeze a window the
 * user can see.
 *
 * Never rejects and never throws: a rejected suggestion promise, a broken timer,
 * anything at all, resolves to `null`. The timer is unref'd where the runtime
 * supports it so a pending deadline cannot hold the process open.
 */
export async function settleTargetLangSuggestion(
  pending: PendingTargetLangSuggestion,
  waitMs: number = COMPOSE_SUGGESTION_WAIT_MS,
): Promise<TranslateLanguageCode | null> {
  if (!pending) return null
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, waitMs))
      // Node's Timeout has `unref`; the DOM's `number` does not. Guarded rather
      // than cast, because this module is unit-tested under both shapes.
      ;(timer as unknown as { unref?: () => void })?.unref?.()
    })
    const settled = await Promise.race([pending.catch(() => null), deadline])
    if (timer !== undefined) clearTimeout(timer)
    return settled ?? null
  } catch {
    return null
  }
}

/**
 * A monotonic ticket per compose-open request. One instance lives in `main.ts`
 * next to the compose window handle; nothing else mints tickets.
 *
 * ## Why a counter exists at all
 *
 * §3.3.B6.f2. Delivering `compose:init` used to be synchronous, so two rapid
 * opens arrived in the order they were made. It is not synchronous any more:
 * the reuse path waits for the language suggestion first, and how long that
 * takes depends on the LETTER — an open with a reply ref runs the detector, an
 * open without one (a forward, a blank message) resolves instantly. So the
 * order of delivery became a function of detection latency rather than of the
 * user's clicks:
 *
 *     press Reply on A      → suggestion pending, delivery waits
 *     press Forward on B    → nothing to detect, delivery is immediate
 *     ⇒ B's form arrives, then A's overwrites it
 *
 * and what the user sees is a compose window addressed to the wrong person,
 * quoting the wrong letter, with anything they had typed in the meantime gone.
 * The renderer cannot defend itself here: its epoch guard covers a late
 * `accounts:get` reply, while a `compose:init` push is by construction the
 * freshest thing it has ever been told.
 *
 * ## Why the loser drops its delivery entirely
 *
 * Not "delivers late", not "delivers without a suggestion" — drops. A superseded
 * open describes a letter the user has already moved on from, and the only
 * thing a late delivery can do is undo the current one.
 */
export interface ComposeOpenSequence {
  /** Claim a ticket for one open. Taken BEFORE any await, never after. */
  next: () => number
  /** Whether `ticket` is still the most recent open. */
  isCurrent: (ticket: number) => boolean
}

export function createComposeOpenSequence(): ComposeOpenSequence {
  let latest = 0
  return {
    next: () => {
      latest += 1
      return latest
    },
    isCurrent: (ticket: number) => ticket === latest,
  }
}

/**
 * Wait for a suggestion (bounded by {@link COMPOSE_SUGGESTION_WAIT_MS}) and then
 * deliver it — but only if `ticket` is still the current open.
 *
 * The whole point is the ORDER of the two steps: the ticket is claimed by the
 * caller before this function is entered, and re-checked AFTER the await, which
 * is the only window in which a newer open can appear.
 *
 * Used by the push path (`compose:init` into a reused window). The
 * request/response path (`compose:getInit`) is deliberately NOT gated: it is an
 * answer to a caller that is waiting for exactly that answer, and dropping it
 * would leave a compose window with nothing at all.
 *
 * Never rejects: the wait cannot (see `settleTargetLangSuggestion`), and a
 * throwing `deliver` — it sends over IPC to a window that may be closing — is
 * caught, logged and reported synthetically rather than becoming an unhandled
 * rejection in main.
 */
export async function deliverIfStillCurrent(
  seq: ComposeOpenSequence,
  ticket: number,
  pending: PendingTargetLangSuggestion,
  deliver: (suggested: TranslateLanguageCode | null) => void,
  waitMs: number = COMPOSE_SUGGESTION_WAIT_MS,
): Promise<void> {
  const suggested = await settleTargetLangSuggestion(pending, waitMs)
  if (!seq.isCurrent(ticket)) return
  try {
    deliver(suggested)
  } catch (err) {
    log.error(`compose translate: delivering compose:init threw: ${String(err)}`)
    captureException(new Error('ai_translate_compose_init_threw'), {
      source: 'ai.translate.draft',
      error_name: classifyDraftErrorName(err),
    })
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Part B — the draft translation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Injected collaborators for one draft translation. Structurally the B7
 * proofread bundle minus what a translation has no use for (no edit anchoring,
 * no per-edit caps) and minus what part 1 needs and this does not (no cache, no
 * language detection).
 */
export interface TranslateDraftDeps {
  /** Per-account opt-in, DEFAULT OFF. Wired to the `aiTranslateEnabled` map —
   *  the SAME consent as the reading side, by explicit product decision: there
   *  is no second toggle for the draft direction. */
  isEnabledForAccount: (accountId: number) => boolean
  /** Local-preferred provider selection (shared with B2/B4/B6/B7). An empty
   *  `provider` means none is configured. `allowFabrication` is FALSE for
   *  self-hosted inference: nobody bills you for a model on your own machine. */
  selectProvider: () => { provider: string; wasLocal: boolean; allowFabrication: boolean }
  /** Per-account single-flight. Burst containment, not the concurrency guard. */
  runExclusive: <T>(accountId: number, run: () => Promise<T>) => Promise<T>
  /** The provider-side output token cap this request runs under. Injected so the
   *  truncation refusal is testable without pinning a number from elsewhere. */
  outputTokenCap: number
  /** §2.51 ATOMIC admission for ONE paid generation. THROWS on a broken meter. */
  admitBudget: (accountId: number, provider: string) => TranslateAdmission
  /** Settle an admitted reservation with the actual cost of a billed call. */
  settleBudget: (
    reservation: TranslateReservation,
    result: TranslateChatResult,
    allowFabrication: boolean,
  ) => void
  /** Release an admitted reservation that was provably not billed. */
  releaseBudget: (reservation: TranslateReservation) => void
  /** One-shot model call, PINNED to `provider`. */
  chat: (provider: string, systemPrompt: string, userPrompt: string) => Promise<TranslateChatOutcome>
  /** Append exactly one PII-free audit row. Best-effort; must not throw. */
  appendAudit: (entry: {
    provider: string
    result: TranslateChatResult | null
    untrustedWrapped: number
    outcome: 'ok' | 'error'
  }) => void
  /**
   * Emit exactly one PII-free span. Fire-and-forget; must not throw or block.
   *
   * `targetLang` is the language the USER named — one of sixteen codes, picked
   * in the interface, not derived from anybody's mail. That is the same ground
   * the reading-side span sends its own `target_lang` on.
   *
   * NOTHING HERE SAYS WHETHER THE TARGET STARTED AS OUR SUGGESTION, and there
   * is deliberately no attribute for it — see the `ai.translate.draft` docblock
   * in `electron/metricsSchema.ts` for why one may not be added back without a
   * decision of its own. The SUGGESTED code and the draft's own language are
   * never sent either: both would be facts derived from mail content against a
   * stable pseudonymous identity (`install_id_hash` rides as the Sentry
   * `user.id`), which is exactly what `telemetryConsent.never.bodies` promises
   * we do not do — the §3.3.B6.f1 retraction applied to this surface.
   */
  recordSpan: (attrs: {
    provider: string
    wasLocal: boolean
    tokensIn: number | null
    tokensOut: number | null
    latencyMs: number
    errorClass: 'none' | 'provider_error' | 'parse_error' | 'internal_error'
    targetLang: string
  }) => void
  /** Report an unexpected throw to Sentry. The implementation sends a SYNTHETIC
   *  exception plus an allowlisted aggregate error class — never `err.message` /
   *  `err.name`, which an arbitrary throw could have loaded with draft text. */
  reportFailure: (marker: string, err: unknown) => void
  /** Monotonic-enough clock, injectable for tests. */
  now: () => number
  /** Structured logger. Never receives draft content. */
  log: {
    warn: (msg: string) => void
    error: (msg: string, err?: unknown) => void
  }
}

/** Everything the pure pre-checks decided before any money or provider is
 *  touched: the own-text to translate and the layout to restore around it. */
type DraftPreparation =
  | { ok: true; ownText: string; lead: string; tail: string }
  | { ok: false; result: TranslateDraftResult }

/**
 * The input gate: every refusal that depends on nothing but the request.
 *
 * Ordered deliberately, and ALL of it happens before the single-flight, the
 * provider selection and the budget admission — none of these refusals may
 * reserve money, occupy the per-account slot, or be reported to the user as "no
 * provider" when the actionable problem is a toggle or the draft itself.
 *
 * The opt-in is FIRST, matching part 1: an opted-out account does not get its
 * draft split, wrapped or measured on an AI path at all.
 *
 * `too_long` is measured on the RECEIVED string, before the split, and refuses
 * rather than truncates — the same rule the reading side states at length. A
 * translation silently cut in half is worse than no translation: nothing in the
 * result says the second half was never translated, so the user sends a
 * complete-looking letter that stops meaning what they wrote.
 *
 * The §2.78 re-split is the server-side half of the own-text boundary. The
 * renderer is expected to send only its own text, but "expected to" is not a
 * guarantee: main re-splits whatever arrives and confines the prompt to
 * `split.own`, keeping `lead` and `tail` verbatim for the join.
 */
export function prepareDraftTranslate(
  deps: TranslateDraftDeps,
  req: TranslateDraftRequest,
): DraftPreparation {
  const refuse = (reason: TranslateDraftRefusalReason): DraftPreparation =>
    ({ ok: false, result: { ok: false, reason } })

  if (!deps.isEnabledForAccount(req.accountId)) {
    return refuse('opt_out')
  }
  if (typeof req?.text !== 'string' || req.text.trim().length === 0) {
    return refuse('empty_input')
  }
  if (req.text.length > TRANSLATE_INPUT_CHAR_CAP) {
    // No length counter here, unlike B7: a raw character count is a fingerprint
    // of one specific piece of writing (§2.78 privacy boundary), and this
    // surface has no bucketing vocabulary of its own to fall back on. The
    // refusal is visible to the user, which is where it needs to be visible.
    deps.log.warn(
      `compose translate: draft over the ${TRANSLATE_INPUT_CHAR_CAP}-char input cap — `
      + 'refusing instead of translating part of it',
    )
    return refuse('too_long')
  }
  const split = splitComposeBody(req.text)
  if (split.own.trim().length === 0) {
    // Its own reason: the fix is "write something above the quote", not
    // "configure a provider" and not "your draft is empty" (§3.3.B4.f3(a)).
    return refuse('no_own_text')
  }
  return { ok: true, ownText: split.own, lead: split.lead, tail: split.tail }
}

/**
 * §3.3 B6 part 2 — translate a draft into `targetLang`.
 *
 * Flow:
 *   1. Pure input gate (`prepareDraftTranslate`): opt-in OFF / empty / over cap
 *      / nothing of the user's own. None of these reserves money, calls a
 *      provider, or takes the single-flight slot.
 *   2. Single-flight per account, then provider selection (none →
 *      `no_provider`, never recorded as a failed API call).
 *   3. §2.51 atomic, fail-closed budget admission → `budget`, never a throw.
 *   4. Generate: wrapUntrusted() the own text → one-shot call pinned to the
 *      selected provider, taken as the un-collapsed billing verdict. `billed`
 *      settles once BEFORE inspecting the output; `unbilled` releases;
 *      `ambiguous` keeps the conservative floor unless the endpoint is
 *      self-hosted.
 *   5. Trim the answer, refuse an empty one or one the provider says it cut off
 *      (`isIncompleteCompletion`, part 1's rule, imported not copied), then
 *      rebuild the payload's layout around it with `joinComposeBody`.
 *
 * NOTHING here is automatic. There is no path into this function that does not
 * begin with the user pressing the translate button: the suggestion above does
 * not call it, the compose window does not call it on open, and changing the
 * target does not call it.
 *
 * Never throws: an unexpected dependency throw is caught, releases any
 * outstanding hold, books its span (and its audit row IF the request had already
 * left the machine — §3.3.B4.f2 narrowed by §3.3.B6.f1), and returns
 * `provider_error`.
 */
export async function generateDraftTranslation(
  deps: TranslateDraftDeps,
  req: TranslateDraftRequest,
): Promise<TranslateDraftResult> {
  let prepared: DraftPreparation
  try {
    prepared = prepareDraftTranslate(deps, req)
  } catch (err) {
    // The gate reads settings, which can throw. Nothing has been generated, so
    // there is no audit row or span to book — only a graceful refusal, so the
    // IPC promise never rejects.
    deps.log.error('compose translate: input gate threw', err)
    deps.reportFailure('ai_translate_draft_gate_threw', err)
    return { ok: false, reason: 'provider_error' }
  }
  if (!prepared.ok) return prepared.result

  const { ownText, lead, tail } = prepared
  try {
    return await deps.runExclusive(
      req.accountId,
      () => runDraftTranslate(deps, req, ownText, lead, tail),
    )
  } catch (err) {
    // `runDraftTranslate` never throws by construction: every path returns a
    // value after booking whatever it owes. Reaching this catch means the
    // generation never got that far — a broken single-flight — so NEITHER
    // record is written here (§3.3.B6.f2):
    //
    //   no audit row, because a request that died in our own queue never left
    //   the machine, and the audit log is the record of what did (§3.3.B6.f1);
    //
    //   no span, because no provider was ever selected. The span used to be
    //   written with an empty provider, which the wiring reports as `unknown` —
    //   a row in the one place that claims to describe provider calls, standing
    //   for a call that was never made, against a disclosure ("emitted only
    //   when a provider was selected") repeated on six documentation pages. The
    //   §3.3.B4.f2 rule is "at most one per request", and zero satisfies it.
    //
    // The failure is not silent: it is a local log line plus a synthetic,
    // PII-free Sentry report, which is where a bug of ours belongs.
    deps.log.error('compose translate: single-flight boundary threw', err)
    deps.reportFailure('ai_translate_draft_exclusive_threw', err)
    return { ok: false, reason: 'provider_error' }
  }
}

/**
 * A clock read that cannot throw. §3.3.B4.f2 asks for exactly one span per
 * generation INCLUDING the unexpected-throw path, so no step of producing that
 * span may itself be a way to lose it — and `now` is injected, i.e. someone
 * else's code.
 */
function readClock(deps: TranslateDraftDeps): number {
  try {
    const t = deps.now()
    return Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

/**
 * The paid half of a draft translation, inside the per-account single-flight.
 *
 * Kept separate from the gate so the broad failure boundary wraps EXACTLY the
 * work that can book money, an audit row or a span — and so the span state
 * (`provider` / `wasLocal` / `started`) is declared where the catch can still
 * see it (§3.3.B4.f2).
 */
async function runDraftTranslate(
  deps: TranslateDraftDeps,
  req: TranslateDraftRequest,
  ownText: string,
  lead: string,
  tail: string,
): Promise<TranslateDraftResult> {
  let spanProvider = ''
  let spanWasLocal = false
  const started = readClock(deps)
  // Whether anything about this draft has actually left the machine. It gates
  // the AUDIT ROW and nothing else (§3.3.B6.f1): the audit log is the user's
  // record of what was sent, so a row for a request that never left is a false
  // entry in the one log they read to check exactly that.
  let leftTheMachine = false
  // A reservation admitted but not yet settled. The handled paths null it out;
  // the broad catch releases whatever is left, so an unexpected throw between
  // admission and the provider call cannot leave a hold lingering (§2.51).
  let reservationToRelease: TranslateReservation | null = null

  const fail = (
    errorClass: 'provider_error' | 'parse_error' | 'internal_error',
    result: TranslateChatResult | null,
    sent: boolean,
  ): TranslateDraftResult => {
    recordDraftFailure(deps, {
      provider: spanProvider,
      wasLocal: spanWasLocal,
      started,
      errorClass,
      result,
      targetLang: req.targetLang,
      leftTheMachine: sent,
    })
    return { ok: false, reason: 'provider_error' }
  }

  try {
    const { provider, wasLocal, allowFabrication } = deps.selectProvider()
    if (!provider) {
      return { ok: false, reason: 'no_provider' }
    }
    spanProvider = provider
    spanWasLocal = wasLocal

    // §2.51 — atomic admission. A denial (over cap) and a broken meter (throw,
    // caught in the helper) both produce the SAME structured refusal.
    const admission = admitDraftBudget(deps, req.accountId, provider)
    if (!admission.ok) {
      return { ok: false, reason: 'budget' }
    }
    reservationToRelease = admission.reservation

    // The whole own-text goes in, unmodified — the cap was enforced as a
    // REFUSAL, so anything reaching here is within it and must not be shortened.
    // wrapUntrusted() neutralizes forged boundary markers inside the draft, and
    // the markers always enclose the entire text the model sees. The system
    // prompt is part 1's, built from the target code alone.
    const systemPrompt = buildTranslateSystemPrompt(req.targetLang)
    const userPrompt = `Translate this email draft:\n\n${wrapUntrusted(ownText)}`

    let outcome: TranslateChatOutcome
    try {
      outcome = await deps.chat(provider, systemPrompt, userPrompt)
    } catch (err) {
      // The chat dep classifies internally and is not expected to throw. If it
      // does we have NO billing evidence either way — KEEP the conservative
      // hold: an over-count is bounded and self-correcting, an under-count is
      // the uncapped spend §2.51 exists to prevent.
      deps.log.error('compose translate: chat dependency threw — holding the reservation floor', err)
      deps.reportFailure('ai_translate_draft_outcome_threw', err)
      reservationToRelease = null
      // No verdict either way, so the audit errs toward RECORDING: under-
      // recording something that was sent is the failure the log exists to
      // prevent, while an extra row for a request that never left is visible and
      // harmless.
      return fail('provider_error', null, true)
    }

    if (outcome.kind !== 'billed') {
      if (outcome.kind === 'unbilled' || !allowFabrication) {
        deps.log.warn(`compose translate: no billable completion (${outcome.reason}) — releasing the hold`)
        releaseDraftReservation(deps, reservationToRelease)
      } else {
        // Dispatched, then the transport failed. Deliberately do NOTHING: the
        // standing reservation is the conservative charge, because releasing
        // here would make "kill the connection late" an unmetered call.
        deps.log.warn(
          `compose translate: transport failure after dispatch (${outcome.reason}) — `
          + 'holding the reservation floor because billing cannot be ruled out',
        )
      }
      reservationToRelease = null
      leftTheMachine = outcome.dispatched === true
      return fail('provider_error', null, leftTheMachine)
    }

    // A billed completion is dispatched by definition.
    leftTheMachine = true
    const result = outcome.result

    // A billed completion spent tokens. Settle EXACTLY ONCE and BEFORE
    // inspecting the output, so a stream of unusable responses still advances
    // the cap — settling only on a usable answer would make the cap decorative
    // for a provider returning junk.
    settleDraftReservation(deps, reservationToRelease, result, allowFabrication)
    reservationToRelease = null

    const translated = normalizeTranslationOutput(result.text)
    if (translated.length === 0) {
      deps.log.warn('compose translate: provider returned no usable text')
      return fail('parse_error', result, true)
    }
    if (isIncompleteCompletion(result, deps.outputTokenCap)) {
      // The answer never reached its end, so the tail of the draft is missing
      // and nothing in the text says so. Refusing beats offering the user a
      // half-translated letter to send. The verdict in the log line is one of
      // four literals THIS repository defines, never provider text.
      deps.log.warn(
        `compose translate: incomplete completion (stop_reason=${result.stopReason}) — `
        + 'refusing a partial translation',
      )
      return fail('parse_error', result, true)
    }

    appendDraftAudit(deps, { provider, result, untrustedWrapped: 1, outcome: 'ok' })
    recordDraftSpan(deps, {
      provider,
      wasLocal,
      tokensIn: result.usage?.inputTokens ?? null,
      tokensOut: result.usage?.outputTokens ?? null,
      latencyMs: readClock(deps) - started,
      errorClass: 'none',
      targetLang: req.targetLang,
    })

    return {
      ok: true,
      translation: {
        // The replacement for exactly the string that arrived: translated own
        // text with whatever quote / banner / signature OUR split found in the
        // payload restored byte-for-byte around it (§2.78 round-trip contract).
        translatedText: joinComposeBody({ lead, own: ownText, tail }, translated),
        targetLang: req.targetLang,
        provider,
      },
    }
  } catch (err) {
    // Unexpected orchestration throw — NOT the handled provider paths above,
    // each of which returns after booking its own audit row and span.
    deps.log.error('compose translate: unexpected orchestration throw', err)
    if (reservationToRelease) {
      releaseDraftReservation(deps, reservationToRelease)
      reservationToRelease = null
    }
    // `internal_error` is its own class: labelling a bug of ours as
    // `provider_error` would poison the signal the class exists to carry.
    deps.reportFailure('ai_translate_draft_failed', err)
    return fail('internal_error', null, leftTheMachine)
  }
}

/**
 * §2.51 — ATOMIC, FAIL-CLOSED budget admission for one draft translation. A
 * denial is a value; a broken meter is a throw, and BOTH deny: a meter that
 * cannot record a spend must never widen the cap. Never throws.
 */
function admitDraftBudget(
  deps: TranslateDraftDeps,
  accountId: number,
  provider: string,
): TranslateAdmission {
  try {
    const admission = deps.admitBudget(accountId, provider)
    return admission.ok ? admission : { ok: false }
  } catch (err) {
    // Only the error's own (code-authored) text reaches the local log — no draft
    // text, address or prompt is in this payload.
    deps.log.error(`compose translate: budget reservation failed — denying (fail-closed): ${String(err)}`)
    return { ok: false }
  }
}

/** Settle one billed completion. Best-effort: a settle failure leaves the
 *  conservative hold standing, which is the safe side for a cap. */
function settleDraftReservation(
  deps: TranslateDraftDeps,
  reservation: TranslateReservation | null,
  result: TranslateChatResult,
  allowFabrication: boolean,
): void {
  if (reservation === null) return
  try {
    deps.settleBudget(reservation, result, allowFabrication)
  } catch {
    deps.log.warn('compose translate: budget settle failed (non-fatal, reservation stands)')
  }
}

/** Release a provably unbilled hold. Best-effort, same reasoning. */
function releaseDraftReservation(
  deps: TranslateDraftDeps,
  reservation: TranslateReservation | null,
): void {
  if (reservation === null) return
  try {
    deps.releaseBudget(reservation)
  } catch {
    deps.log.warn('compose translate: budget release failed (non-fatal, hold stands)')
  }
}

/** Emit one span, wrapped so a broken sink can never fail the request. */
function recordDraftSpan(
  deps: TranslateDraftDeps,
  attrs: Parameters<TranslateDraftDeps['recordSpan']>[0],
): void {
  try {
    deps.recordSpan(attrs)
  } catch { /* telemetry must never break a translation */ }
}

/**
 * One audit row, best-effort, from EVERY path that writes one. Individually
 * wrapped because the sink is injected and the contract only says it "must not
 * throw": an unwrapped throwing sink on the SUCCESS path would escape into the
 * outer catch, turning a translation the user could have used into a
 * `provider_error` and booking a SECOND row saying the call failed
 * (§3.3.B6.f1 review iteration 2).
 */
function appendDraftAudit(
  deps: TranslateDraftDeps,
  entry: Parameters<TranslateDraftDeps['appendAudit']>[0],
): void {
  try {
    deps.appendAudit(entry)
  } catch { /* audit is best-effort */ }
}

/**
 * One span for a failed generation IF a provider was selected, and an audit row
 * ONLY IF the request actually reached one (`leftTheMachine`). Both
 * best-effort and individually wrapped, so a broken sink can never turn a
 * graceful refusal into a throw.
 *
 * TWO different rules, deliberately, because the two records answer different
 * questions:
 *
 *   - the AUDIT LOG is the user's record of WHAT WAS SENT (§3.3.B6.f1), so a
 *     missing API key, an unsupported provider or an unresolvable host must not
 *     write one;
 *   - the SPAN is our record of provider calls we attempted, so those same
 *     attempts DO appear in it — but a failure BEFORE a provider was selected
 *     does not (§3.3.B6.f2), because there was no attempt to describe and the
 *     empty provider would be published as `unknown`.
 */
function recordDraftFailure(
  deps: TranslateDraftDeps,
  args: {
    provider: string
    wasLocal: boolean
    started: number
    errorClass: 'provider_error' | 'parse_error' | 'internal_error'
    result: TranslateChatResult | null
    targetLang: string
    leftTheMachine: boolean
  },
): void {
  // NO PROVIDER, NO SPAN (§3.3.B6.f2). An empty provider means the failure
  // happened before one was selected, and the wiring would report it as
  // `unknown` — a telemetry row describing a provider call that was never made,
  // contradicting the disclosure this span carries. The audit rule below is
  // stricter still and independent of it: a row only for what actually left.
  if (!args.provider) {
    if (args.leftTheMachine) {
      // Unreachable by construction (nothing can leave the machine before a
      // provider is chosen). Kept rather than assumed: the audit log is the
      // stronger promise of the two, so if this ever becomes reachable the row
      // is written and the missing span is the thing to go and explain.
      appendDraftAudit(deps, {
        provider: 'unknown',
        result: args.result,
        untrustedWrapped: 1,
        outcome: 'error',
      })
    }
    return
  }
  if (args.leftTheMachine) {
    appendDraftAudit(deps, {
      provider: args.provider,
      result: args.result,
      untrustedWrapped: 1,
      outcome: 'error',
    })
  }
  recordDraftSpan(deps, {
    provider: args.provider,
    wasLocal: args.wasLocal,
    tokensIn: args.result?.usage?.inputTokens ?? null,
    tokensOut: args.result?.usage?.outputTokens ?? null,
    latencyMs: readClock(deps) - args.started,
    errorClass: args.errorClass,
    targetLang: args.targetLang,
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Wiring — the real collaborators.
//
// Lives here rather than in `ai.ts` (hotspot, CLAUDE.md §5) for the reason
// `aiTranslate.ts` gives: everything this needs from the AI service is already
// exported — provider selection, the §2.51 admission/settle/release trio, the
// one-shot billing verdict — and nothing below re-implements any of it.
// ──────────────────────────────────────────────────────────────────────────

/** Providers allowed to appear in telemetry, mirroring `ai_provider`. */
const TELEMETRY_PROVIDERS = ['anthropic-api', 'openai-api', 'gemini-api', 'local'] as const

/**
 * Classify a caught throw into an allowlisted, PII-free class for Sentry.
 *
 * `Error.name` is a MUTABLE public property, so an arbitrary throw can carry
 * `err.name = '<draft text>'`. We therefore classify by `instanceof` (prototype
 * chain, not spoofable) and return ONLY literals from this file — never
 * `err.name` / `err.message`.
 */
function classifyDraftErrorName(err: unknown): string {
  if (err instanceof TypeError) return 'TypeError'
  if (err instanceof RangeError) return 'RangeError'
  if (err instanceof SyntaxError) return 'SyntaxError'
  if (err instanceof ReferenceError) return 'ReferenceError'
  if (err instanceof Error) return 'Error'
  return 'UnknownError'
}

/**
 * Whether the per-account translate opt-in is ON. Default OFF — a missing map, a
 * missing entry and an unreadable settings snapshot all mean OFF.
 *
 * The SAME setting the reading side gates on, by explicit product decision:
 * "translate my mail with an AI provider" is one consent, and a second toggle
 * for the draft direction would ask the user to answer the same question twice
 * about the same key, the same provider and the same audit log.
 */
function isDraftTranslateEnabled(accountId: number): boolean {
  try {
    const raw = (getSettings() as { aiTranslateEnabled?: Record<string, boolean> }).aiTranslateEnabled
    return raw?.[String(accountId)] === true
  } catch {
    // Fail-closed: an unreadable settings snapshot must not opt an account in.
    return false
  }
}

/** Per-account single-flight for draft translations. Keyed per account so
 *  unrelated accounts never block each other; the predecessor is settled with
 *  `.catch()` before chaining so one failure cannot poison the chain. */
const draftTranslateInFlight = new Map<number, Promise<unknown>>()

function withDraftSingleFlight<T>(accountId: number, run: () => Promise<T>): Promise<T> {
  const predecessor = draftTranslateInFlight.get(accountId)
  const gated = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(run)
  draftTranslateInFlight.set(accountId, gated)
  gated
    .catch(() => undefined)
    .finally(() => {
      if (draftTranslateInFlight.get(accountId) === gated) {
        draftTranslateInFlight.delete(accountId)
      }
    })
    .catch(() => { /* swallow — the real result/rejection propagates via `gated` */ })
  return gated
}

/**
 * Build the real dependency bundle for one draft translation.
 *
 * EXPORTED FOR TESTS, and not as a courtesy: two facts live only here — the
 * locality classification (which needs BOTH the provider id and the
 * OpenAI-compatible base URL, §3.3.B6.f1) and the `AiChatSimpleOutcome` →
 * `dispatched` translation inside `chat` — plus the identity of `runExclusive`,
 * which is the PRODUCTION queue. A suite that hand-injected look-alikes for
 * those would assert its own fixture.
 */
export function buildDraftTranslateDeps(): TranslateDraftDeps {
  // ONE settings snapshot for the whole generation, taken BEFORE admission and
  // used through to settlement (§2.51.f2 iteration 7): pricing, execution and
  // settlement must all describe the same endpoint, or a base-URL change
  // mid-request settles a paid call at 0 (or charges a local one).
  const settings = getSettings()
  const selection = selectSummaryProvider(settings)
  const provider = selection.provider ?? ''
  const endpointIsLocal = provider ? isLocalInferenceEndpoint(provider, settings) : false
  const wasLocal = selection.wasLocal === true || endpointIsLocal
  // Nobody bills you for a model on your own machine — same input, opposite
  // question, so it stays derived from the endpoint classification alone.
  const allowFabrication = !endpointIsLocal

  return {
    isEnabledForAccount: isDraftTranslateEnabled,
    selectProvider: () => ({ provider, wasLocal, allowFabrication }),
    runExclusive: withDraftSingleFlight,
    outputTokenCap: AI_CHAT_SIMPLE_MAX_OUTPUT_TOKENS,
    admitBudget: (accountId, prov) => {
      // Same model string the other one-shot paths reserve against
      // (`settings.aiModel || ''`) — the reservation is a conservative FLOOR,
      // re-priced from the provider-reported model at settle time.
      const admission = admitBudgetedCall(settings, String(accountId), prov, settings.aiModel || '')
      return admission.ok ? { ok: true, reservation: admission.reservation } : { ok: false }
    },
    settleBudget: (reservation, result, fabricate) => {
      settleReservationUsd(reservation as AiCostReservation, estimateDraftCostUsd(result, fabricate))
    },
    releaseBudget: (reservation) => { releaseReservationNoSpend(reservation as AiCostReservation) },
    chat: (prov, systemPrompt, userPrompt) => (
      // The PINNED provider and the PINNED settings snapshot: without them the
      // helper re-reads settings and could run against a different base URL and
      // model than the one the admission priced.
      aiChatSimpleOutcome(systemPrompt, userPrompt, prov as AiProvider, { settings })
        .then(toDraftChatOutcome)
    ),
    appendAudit: ({ provider: prov, result, untrustedWrapped, outcome }) => {
      try {
        appendAiActionLog({
          provider: prov,
          model: result?.model ?? null,
          // A new `goal` value, alongside part 1's `translate_message`. The goal
          // column is free-form text written only by main and rendered as a
          // label by the privacy panel; the two are kept DISTINCT because the
          // user's question about them is different — one says a message they
          // received was sent to a provider, the other says text they wrote was.
          goal: 'translate_draft',
          toolName: null,
          inputTokens: result?.usage?.inputTokens ?? null,
          outputTokens: result?.usage?.outputTokens ?? null,
          costUsd: null,
          untrustedWrapped,
          injectionBlocked: 0,
          outcome,
        })
      } catch { /* audit is best-effort */ }
    },
    recordSpan: (attrs) => {
      try {
        const span = startMetricSpan('ai.translate.draft', {
          provider: (TELEMETRY_PROVIDERS as readonly string[]).includes(attrs.provider)
            ? attrs.provider
            : 'unknown',
          was_local: attrs.wasLocal,
          tokens_in: attrs.tokensIn ?? 0,
          tokens_out: attrs.tokensOut ?? 0,
          latency_ms: attrs.latencyMs,
          error_class: attrs.errorClass,
          // The target IS sent: one of sixteen codes the user picked in the
          // interface, not derived from anybody's mail. Neither the SUGGESTED
          // code nor any flag about whether the target came from a suggestion is
          // sent — see `recordSpan` on TranslateDraftDeps.
          target_lang: attrs.targetLang,
        })
        span.end()
      } catch { /* telemetry must never break a translation */ }
    },
    reportFailure: (marker, err) => {
      captureException(new Error(marker), {
        source: 'ai.translate.draft',
        error_name: classifyDraftErrorName(err),
      })
    },
    now: () => Date.now(),
    log: {
      warn: (msg) => log.warn(msg),
      error: (msg, err) => log.error(err === undefined ? msg : `${msg}: ${err}`),
    },
  }
}

/**
 * `AiChatSimpleOutcome` → `TranslateChatOutcome`, adding the one fact the AI
 * service knows and the generator needs: whether the request LEFT THE MACHINE.
 *
 * Spelled out here rather than imported from `aiTranslate.ts` because that
 * module's copy is private, and the switch is exhaustive over the AI service's
 * vocabulary — so a new reason added there is a COMPILE ERROR here rather than a
 * silent default. That matters: the default a careless reader would pick is
 * `true`, and the whole point of the flag is that some of these never left.
 *
 *   no_key / no_provider / unsupported — refused before a socket existed.
 *   pre_dispatch_error                 — settings, key store or proxy-agent
 *                                        construction threw before dispatch.
 *   unreachable                        — connection refused / host unresolvable;
 *                                        provably delivered nothing.
 *   rejected                           — a 4xx. The provider ANSWERED, so the
 *                                        request was sent; it simply was not
 *                                        billed.
 *   transport / server_error           — dispatched, then lost.
 */
function toDraftChatOutcome(outcome: AiChatSimpleOutcome): TranslateChatOutcome {
  if (outcome.kind === 'billed') return outcome
  if (outcome.kind === 'ambiguous') {
    // Both ambiguous reasons ('transport', 'server_error') describe a failure
    // AFTER dispatch, by their own definitions in ai.ts.
    return { kind: 'ambiguous', reason: outcome.reason, dispatched: true }
  }
  const reason = outcome.reason
  let dispatched: boolean
  switch (reason) {
    case 'no_provider':
    case 'no_key':
    case 'unsupported':
    case 'pre_dispatch_error':
    case 'unreachable':
      dispatched = false
      break
    case 'rejected':
      dispatched = true
      break
    default: {
      // Exhaustiveness guard: `reason` is `never` here while the switch covers
      // the union. If this stops compiling, a new unbilled reason was added in
      // ai.ts and someone has to decide whether it left the machine.
      const exhaustive: never = reason
      void exhaustive
      // Unreachable at runtime; the safe side for an unclassified reason is to
      // record it, for the same asymmetry as the chat-threw path.
      dispatched = true
    }
  }
  return { kind: 'unbilled', reason, dispatched }
}

/**
 * Price a billed completion from real usage via the SINGLE core pricing table.
 * An unpriceable completion against SELF-HOSTED inference costs nothing (there
 * is no provider to bill); against a paid API it falls back to the conservative
 * model-aware floor rather than 0, so an unpriceable paid call still counts.
 */
function estimateDraftCostUsd(result: TranslateChatResult, allowFabrication: boolean): number {
  const priced = estimateAiRuleCostUsd(result.model, result.usage ?? undefined)
  if (typeof priced === 'number' && Number.isFinite(priced) && priced > 0) return priced
  if (!allowFabrication) return 0
  const reserved = nullUsageReservationUsd(result.model)
  return Number.isFinite(reserved) && reserved > 0 ? reserved : 0
}

/**
 * Build the real dependency bundle for one suggestion. `scorer` is the shared,
 * lazily-loaded franc wrapper from `aiTranslate.ts` — the same instance the
 * reading path uses, so the trigram table is paged in at most once per process.
 * A missing scorer costs the SUGGESTION and nothing else.
 */
export function buildSuggestTargetLangDeps(scorer: TrigramScorer | null): SuggestTargetLangDeps {
  return {
    isEnabledForAccount: isDraftTranslateEnabled,
    getMessageText: (accountId, folder, uid) => {
      const row = getMessageByUid(accountId, folder, uid)
      return typeof row?.bodyText === 'string' ? row.bodyText : null
    },
    detectLanguage: (text) => (
      scorer ? detectTextLanguage(text, scorer) : { ok: false, reason: 'undetermined' }
    ),
    log: {
      error: (msg, err) => {
        log.error(err === undefined ? msg : `${msg}: ${err}`)
        captureException(new Error('ai_translate_suggest_failed'), {
          source: 'ai.translate.draft',
          error_name: classifyDraftErrorName(err),
        })
      },
    },
  }
}

/**
 * Start detecting a suggested target language for a compose window.
 *
 * Returns a promise (never `null` unless there is nothing to detect) that
 * `main.ts` parks in the compose context and settles later through
 * {@link settleTargetLangSuggestion}. STARTING it here rather than awaiting it
 * is what keeps `ui:openCompose` synchronous: opening the window must not wait
 * on an advisory caption, and the ceiling on the wait is applied at delivery.
 *
 * Never rejects.
 */
export function startTargetLangSuggestion(
  ref: { accountId: number; folder: string; uid: number } | null | undefined,
): PendingTargetLangSuggestion {
  // No reference ⇒ nothing to read ⇒ do not even load the detector. A forward
  // and a brand-new message take this path, and so does every compose open in a
  // build where the reply ref was not carried.
  if (!ref) return null
  // The opt-in is checked HERE TOO, before `resolveTrigramScorer()` (§3.3.B6.f2).
  // The gate inside `suggestReplyTargetLang` is correct and stays — it is what
  // keeps an opted-out account's text out of the cache read — but it runs after
  // the loader, so an opted-out mailbox still paged in franc's 180-language
  // table on every "Reply". That contradicted the stated intent one line above
  // ("do not even load the detector"), and the cheapest honest fix is to ask
  // the question in the order the intent describes. Fail-closed by
  // construction: `isDraftTranslateEnabled` swallows its own errors into OFF.
  if (!isDraftTranslateEnabled(ref.accountId)) return null
  return (async () => {
    try {
      const scorer = await resolveTrigramScorer()
      return suggestReplyTargetLang(buildSuggestTargetLangDeps(scorer), ref)
    } catch (err) {
      log.error(`compose translate: suggestion setup threw: ${String(err)}`)
      captureException(new Error('ai_translate_suggest_setup_threw'), {
        source: 'ai.translate.draft',
        error_name: classifyDraftErrorName(err),
      })
      return null
    }
  })()
}

/**
 * §3.3 B6 part 2 — translate a draft, for the `ai:translate:draft` IPC handler.
 *
 * Never throws: the generator owns the full structured-refusal ladder and maps
 * any unexpected dependency throw to `provider_error` itself.
 */
export async function translateDraft(req: TranslateDraftRequest): Promise<TranslateDraftResult> {
  try {
    return await generateDraftTranslation(buildDraftTranslateDeps(), req)
  } catch (err) {
    // Building the deps bundle reads settings and can throw before the
    // generator's own boundary exists. Refuse gracefully — the IPC promise must
    // never reject.
    log.error(`compose translate: request setup threw: ${String(err)}`)
    captureException(new Error('ai_translate_draft_setup_threw'), {
      source: 'ai.translate.draft',
      error_name: classifyDraftErrorName(err),
    })
    return { ok: false, reason: 'provider_error' }
  }
}
