import { useCallback, useEffect, useRef, useState } from 'react'
import { joinComposeBody, splitComposeBody } from '@mailcopilot/core'
import type {
  TranslateDraftRefusalReason,
  TranslateDraftRequest,
  TranslateDraftResult,
  TranslateLanguageCode,
} from '@mailcopilot/types'
import { captureException } from '../sentry'
import { hasRewritableText } from '../utils/quickActions'

/**
 * useDraftTranslation — §3.3 B6 part 2, the DRAFT side (renderer).
 *
 * Owns the whole state machine of the compose translate control: which target
 * language is selected, whether a request is in flight, what came back, and the
 * before/after pair the review panel renders. `ComposeQuickActions` draws this
 * hook's output and holds no translate state of its own (CLAUDE.md §5).
 *
 * ## Four properties this hook exists to guarantee
 *
 * 1. **Never automatic.** There is no effect that calls a provider. The only
 *    path to `ai:translate:draft` is {@link UseDraftTranslationResult.run},
 *    reachable only from a click — not on window open, not when the suggestion
 *    appears, not when the user changes the target, and not a second time after
 *    a translation exists.
 *
 * 2. **One recorded priority rule for the target language.** In descending
 *    order: the user's pick in THIS draft, then `suggestedTargetLang`, then
 *    nothing (and the button is inert). The rule is the single expression
 *    `chosen ?? suggested`, so "the pick wins, always and irreversibly within
 *    the draft" is a property of the shape rather than of an effect's ordering:
 *    once `chosen` is set no later suggestion can be read.
 *
 * 3. **The memory belongs to the DRAFT, not to the window.** A `compose:init`
 *    (the window was reused for a reply to a different message) resets the
 *    pick, and the new message's suggestion applies. A remembered target is a
 *    statement about the recipient of THIS mail, and changing the form changes
 *    the recipient — without the reset a choice made about a Spaniard would
 *    silently override a well-founded suggestion about a German. Same device as
 *    the `targetKey` reset in `useMailTranslation.ts`. It lives in window state
 *    only: nothing here writes to settings, the store or the database, and no
 *    persistent language preference exists in the product.
 *
 *    The reset is keyed on `composeGeneration` and on NOTHING else. Two
 *    corollaries, both of them defects that were fixed rather than accidents of
 *    the current shape:
 *      - the key must be stable from the first paint. An asynchronously
 *        resolving storage identifier (`draftId`) is not: the compose form is
 *        already interactive while it is still empty, so a pick or a paid
 *        request made in that window was dropped by the later `'' → id`
 *        transition.
 *      - switching mailbox or flipping the per-account opt-in is NOT a new
 *        draft. Those invalidate an in-flight request and whatever it produced
 *        (a separate effect below), but they must not erase the pick —
 *        otherwise "the pick beats the suggestion irreversibly within this
 *        draft" is not a property the user can rely on.
 *
 * 4. **A useless repeat is never offered** (2026-08-31). Some refusals cannot
 *    answer differently until something outside the request changes, and the
 *    expensive one — the provider ran out of output room — repeats a BILLED
 *    call to produce the identical nothing. {@link
 *    UseDraftTranslationResult.canRetryFor} is what the toolbar asks before
 *    leaving the button live. It takes the draft body as an argument because on
 *    this side the input is editable: the escape from those refusals is an
 *    edit, so a verdict that ignored the text would turn "shorten it and try
 *    again" into advice the interface refuses to let the writer follow.
 *
 * ## What crosses the wire
 *
 * `splitComposeBody(body).own` and a member of the closed sixteen-code enum —
 * never a model instruction, and never a quoted original, a forwarded message
 * or a signature THAT THE SPLIT RECOGNIZES (§2.78). Main does not trust the
 * split: it re-runs it and prompts only what its own split calls the user's
 * text. Nothing is written back to the draft here; the body only changes when
 * the component's explicit Replace/Insert callback runs.
 *
 * That last guarantee is exactly as wide as the detector and NOT one byte
 * wider, and the difference is user-visible. Several real quoting styles
 * written by other mail clients carry no marker `splitComposeBody` keys off; on
 * such a draft no boundary is found at all, `own` IS the whole body, and the
 * whole body — the correspondent's words included — crosses the wire. The
 * canonical list and the reasoning live in the "Known v1 limitation — quoting
 * styles this detector does NOT recognize" block of
 * `packages/core/composeBody.ts`; do not copy it here, a second copy drifts.
 * Do not write "the quote never reaches the provider" in this file, in the UI,
 * or in the docs: that sentence was shipped once and was false. The consent
 * copy `ai.settings.translate.help` now states the limit out loud in all six
 * locales, because the toggle's help text is a disclosure and §2.82 requires a
 * disclosure to match what is actually sent — so widening or narrowing the
 * detector obliges you to move that string too.
 *
 * The request deliberately carries NO "this came from the suggestion" flag: it
 * would be a renderer's claim about its own state that main cannot check, and
 * telemetry must not rest on one.
 *
 * ## Occupancy is a fact about the REQUEST, not about the intent
 *
 * {@link UseDraftTranslationResult.busy} is true exactly while a call is on the
 * wire, and it is what `ComposeQuickActions` reads to decide "this draft is
 * occupied" — deliberately NOT `status === 'loading'`. The two came apart on
 * one path and that was a defect (§3.3 B6.f3): changing the target language
 * mid-flight invalidates the ANSWER (`requestIdRef`) and returns the status to
 * `idle`, because a translation into German is not an answer to a question
 * about French. It does not, and cannot, stop the call that is already out.
 * Reading occupancy off the status therefore freed the whole bar — rewrite,
 * proofread and a second translation — while the first, still-billed request
 * was running.
 *
 * `busy` is cleared by ONE event: the request settling. Neither
 * {@link UseDraftTranslationResult.setTargetLang} nor
 * {@link UseDraftTranslationResult.dismiss} clears it; they change what we will
 * accept, not what we are paying for. The two reset effects below DO clear it,
 * and that is not an exception to the rule but a different subject: they fire
 * when the form is no longer writing that draft at all (a new `compose:init`)
 * or is writing it under a different account/permission, and an abandoned
 * request must not hold a toolbar that now belongs to another message — which
 * also bounds the damage of a provider that never answers.
 */

export type DraftTranslationStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** The before/after material the review panel renders. */
export type DraftTranslationPreview = {
  /** The user's OWN text as it was at request time (the "before" side). */
  original: string
  /** The translation of exactly that string (the "after" side). */
  rewritten: string
  /** The FULL body at request time — only read by `isPreviewStale`. */
  sourceBody: string
  /**
   * The full body to write on Replace: the translated own part spliced back
   * into the original layout with the quoted / forwarded / signature tail
   * byte-identical (§2.78).
   */
  replacement: string
}

export type UseDraftTranslationParams = {
  /** Account authoring the draft; `null` makes the hook inert. */
  accountId: number | null
  /**
   * Per-account opt-in (`settings.aiTranslateEnabled["<accountId>"]`), the SAME
   * setting as the reading side. Main gates independently and answers
   * `opt_out`; this only avoids offering an action known to refuse.
   */
  enabled: boolean
  /**
   * Language this reply is probably meant to be written in, minted by main from
   * the message being replied to. A SUGGESTION: it pre-fills the picker until
   * the user picks, starts nothing, and is `null` for a forward, a new message
   * or an undetermined language.
   */
  suggestedTargetLang: TranslateLanguageCode | null
  /**
   * Generation of the compose form: a counter the window bumps on every
   * `compose:init`. An increment means "this form was re-initialized for
   * another message", which drops the remembered pick so the new message's
   * suggestion applies (property 3).
   *
   * A counter, not the draft's storage id, ON PURPOSE — see property 3. The
   * only requirement is that it is stable from the first render and changes
   * synchronously with the re-initialization event.
   */
  composeGeneration: number
  /** Injectable IPC runner (tests). */
  translate?: (req: TranslateDraftRequest) => Promise<TranslateDraftResult>
}

export type UseDraftTranslationResult = {
  /** Whether the control should render at all. */
  active: boolean
  status: DraftTranslationStatus
  /** Effective target under the priority rule; `null` means "nothing chosen". */
  targetLang: TranslateLanguageCode | null
  /** Before/after pair while `status === 'ready'`, else null. */
  preview: DraftTranslationPreview | null
  /** Structured refusal while `status === 'refused'`, else null. */
  refusal: TranslateDraftRefusalReason | null
  /** True when a request would have a target to translate into. */
  canRun: boolean
  /**
   * True while a call is actually on the wire. The occupancy signal for the
   * toolbar — see "Occupancy is a fact about the REQUEST" above. A superset of
   * `status === 'loading'`: the status can fall back to `idle` the moment the
   * user re-aims (a new target language), while the request they already paid
   * for is still running.
   */
  busy: boolean
  /**
   * Whether pressing Translate again over `body` could answer differently
   * (2026-08-31).
   *
   * `true` whenever nothing is refusing, so the ordinary states are untouched.
   * `false` only for a refusal with no realistic chance of answering differently
   * until something outside this request changes — and then only while the text
   * that would be SENT is still the text that was refused, byte for byte. The
   * toolbar disables the button in that state rather than leaving a live control
   * whose outcome we already expect: a dead-looking button and a button that is
   * genuinely dead are the same defect wearing different clothes, and here a
   * press is not even free — the case this exists for (`answer_too_long`) is
   * very likely to spend a fresh billed call on the identical nothing.
   *
   * A FUNCTION OF THE BODY, not a boolean, on purpose. The reading pane's
   * `canRetry` can be a plain flag because a message does not change under the
   * reader; a draft changes every keystroke, and the escape from every one of
   * these refusals is an edit. Taking the body as an argument means the caller
   * cannot ask the question without saying which draft it is about, so a stale
   * verdict cannot outlive the text it was about. It takes the WHOLE body and
   * splits it here, rather than asking the caller for the own-text half: the
   * toolbar holds the draft, and a caller that had to pre-split could pre-split
   * differently from `run` — which is the disagreement this comparison exists to
   * prevent.
   */
  canRetryFor: (body: string) => boolean
  /** Record the user's pick for this draft. Never reaches a provider by itself. */
  setTargetLang: (code: TranslateLanguageCode) => void
  /** Explicit user action — the ONLY path that can reach a provider. */
  run: (body: string) => void
  /** Dismiss the preview / refusal and return to idle. */
  dismiss: () => void
}

/**
 * Whether another press at THIS refusal could answer differently, ASSUMING the
 * draft is unchanged (2026-08-31).
 *
 * The same rule the reading pane applies in `refusalAllowsRetry`
 * (`useMailTranslation.ts`), asked with the same question: is a second press,
 * made right now with nothing else changed, REASONABLY LIKELY to produce a
 * different result? Where the answer is no, the toolbar draws no live control —
 * a control whose outcome we can already predict is a poor thing to offer, and
 * on this bar it is not a free one either: a repeat that main does not refuse
 * before dispatch is a fresh billed request against the writer's own key.
 *
 * PROBABLE, NOT PROVEN — see the same paragraph in `refusalAllowsRetry`. A
 * provider is not guaranteed to be deterministic, and these calls go out with a
 * non-zero temperature, so a repeat CAN answer differently. The refusal proves
 * the LAST answer hit the ceiling, not that every future one must. We suppress
 * because the repeat is very likely to reproduce it and costs money to find out.
 *
 * ONE DIFFERENCE FROM THE READING SIDE, and it is the whole reason this function
 * exists separately instead of being imported: the input is EDITABLE. A message
 * cannot change under the reader, so there the verdict is a property of the
 * reason alone; a draft changes every keystroke, and "the same request" is
 * therefore a pair — the reason AND the string that was actually sent for it,
 * which is the own-text half of the draft and not the whole body. That is why
 * nothing here is exported as a bare boolean: the hook publishes
 * {@link UseDraftTranslationResult.canRetryFor}, which cannot be consulted
 * without saying which body is being asked about.
 *
 * Exhaustive over `TranslateDraftRefusalReason` with a `never` guard, so a
 * reason added to the wire contract cannot quietly inherit someone else's
 * verdict.
 *
 *   answer_too_long — NO. The own text and the output ceiling are exactly what
 *     they were a moment ago, so a repeat asks the same model for the same thing
 *     under the same limit — very likely the same refusal. This is the case the
 *     2026-08-31 incident was made of, and the expensive one: a repeat that
 *     reaches the provider is billed whatever it answers.
 *   too_long — NO. The input cap is measured on the received string before any
 *     call; the same string measures the same.
 *   opt_out — NO. Turning the setting on flips `enabled`, which resets this hook
 *     and takes the refusal with it; so a press while the refusal is still on
 *     screen is a press against an unchanged setting.
 *   empty_input — NO for this request. On the DRAFT side this means "there is
 *     nothing of yours to translate", not the reading side's "the body is still
 *     downloading": nothing arrives on its own, and the fix is to write
 *     something — which changes the own text and revives the control by itself.
 *   no_own_text — NO for this request, for the same reason: the answer is to
 *     write above the quote, and that is an edit to the own text. Editing INSIDE
 *     the quote correctly leaves the control dead — it changes nothing the
 *     provider would see.
 *   budget — YES. The cap belongs to a period that rolls, and it can also be
 *     raised in Settings without anything here resetting.
 *   no_provider — YES. Configuring a provider changes nothing in this hook's
 *     state, so the refusal stays on screen and the retry is the way back.
 *   provider_error — YES. By construction this is now the reason we have NO
 *     explanation for, and an unexplained failure may well be transient. That is
 *     the whole value of having split `answer_too_long` out of it.
 */
function draftRefusalAllowsRetry(reason: TranslateDraftRefusalReason): boolean {
  switch (reason) {
    case 'answer_too_long':
    case 'too_long':
    case 'opt_out':
    case 'empty_input':
    case 'no_own_text':
      return false
    case 'budget':
    case 'no_provider':
    case 'provider_error':
      return true
    default: {
      const exhaustive: never = reason
      void exhaustive
      // An unknown reason from a newer main is not evidence that retrying is
      // pointless, and refusing to draw the control would strand the writer
      // with no way forward at all. Offer it.
      return true
    }
  }
}

/** Default IPC runner — invokes the whitelisted `ai:translate:draft` channel. */
async function defaultTranslate(req: TranslateDraftRequest): Promise<TranslateDraftResult> {
  return (await window.api.invoke('ai:translate:draft', req)) as TranslateDraftResult
}

export function useDraftTranslation({
  accountId,
  enabled,
  suggestedTargetLang,
  composeGeneration,
  translate = defaultTranslate,
}: UseDraftTranslationParams): UseDraftTranslationResult {
  const [status, setStatus] = useState<DraftTranslationStatus>('idle')
  const [preview, setPreview] = useState<DraftTranslationPreview | null>(null)
  // ONE piece of state for two facts that must never disagree: what was refused
  // and WHICH REQUEST it was refused for. Kept together rather than as two
  // `useState`s because every clear site would otherwise have to remember both,
  // and a leftover from a forgotten clear would keep the translate button dead
  // for a draft nothing is refusing (see `canRetryFor`).
  //
  // `sentText` is the OWN-TEXT half of the draft — `splitComposeBody(body).own`,
  // which is exactly and only what `run` puts on the wire — never the whole
  // body. Keying on the whole body re-armed the button when the writer touched
  // the signature, the separator or the quoted tail, none of which change the
  // request by a single byte: the next press would send the identical string
  // and pay for the identical refusal. Compare what is actually sent.
  const [refusalState, setRefusalState] =
    useState<{ reason: TranslateDraftRefusalReason; sentText: string } | null>(null)
  const refusal = refusalState?.reason ?? null
  // The user's pick, and ONLY the user's pick. The suggestion is never written
  // into it, so "was there a pick in this draft?" stays answerable and the
  // priority rule below cannot be defeated by a later re-render.
  const [chosen, setChosen] = useState<TranslateLanguageCode | null>(null)

  const translateRef = useRef(translate)
  translateRef.current = translate
  // Monotonic token: a response whose token no longer matches is dropped, so a
  // late answer cannot land under a different draft or a different target.
  const requestIdRef = useRef(0)
  // Tokens of the calls currently on the wire. A SET rather than a counter so
  // the reset effects can drop the ones they abandon without a later settle
  // decrementing a count it no longer belongs to.
  const inFlightRef = useRef<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const targetLang = chosen ?? suggestedTargetLang

  const paramsRef = useRef({ accountId, enabled, targetLang })
  paramsRef.current = { accountId, enabled, targetLang }

  // Property 3: a new draft is a new question. Everything the previous one
  // produced — including the remembered pick — goes with it, and the token is
  // bumped so an in-flight answer to the old draft is discarded rather than
  // painted over the new one. `composeGeneration` is the ONLY dependency: it is
  // the one input that means "another message is being written now".
  useEffect(() => {
    requestIdRef.current++
    // The form is writing another message now: a request made about the
    // previous one must not keep this bar occupied (and a provider that never
    // answers must not occupy it forever).
    inFlightRef.current.clear()
    setBusy(false)
    setChosen(null)
    setStatus('idle')
    setPreview(null)
    setRefusalState(null)
  }, [composeGeneration])

  // A different sender account, or the per-account opt-in flipping, is a
  // different *permission and provider* for the same draft — not a different
  // draft. An answer produced under the previous one is not an answer to the
  // current question, so the token is bumped and anything it produced is
  // cleared; the user's pick is deliberately left alone (property 3, second
  // corollary). Kept separate from the reset above rather than folded into its
  // dependency list, because the two are different events with different
  // consequences.
  useEffect(() => {
    requestIdRef.current++
    // Same reason as above: what the abandoned call answers is a question put
    // under the previous account and the previous permission.
    inFlightRef.current.clear()
    setBusy(false)
    setStatus('idle')
    setPreview(null)
    setRefusalState(null)
  }, [accountId, enabled])

  const setTargetLang = useCallback((code: TranslateLanguageCode) => {
    setChosen(prev => (prev === code ? prev : code))
    // A result produced for another target is not an answer to this one; drop
    // it rather than leaving a panel whose language label disagrees with it.
    // Bumping first invalidates an in-flight request for the same reason.
    //
    // What this does NOT do is stop the call already on the wire, so `busy` is
    // untouched here on purpose: re-aiming is not completion, and the bar stays
    // occupied until the request the user is paying for actually settles.
    requestIdRef.current++
    setPreview(null)
    setRefusalState(null)
    setStatus('idle')
  }, [])

  const run = useCallback((body: string) => {
    const { accountId: id, enabled: on, targetLang: to } = paramsRef.current
    if (!on || typeof id !== 'number' || !to) return
    // One paid call at a time. The button is disabled while `busy`, so this
    // only catches a programmatic click — but the whole point of the fix is
    // that "the user changed the target mid-flight" no longer looks idle, and
    // that must hold at the entry point too, not only in the rendering.
    if (inFlightRef.current.size > 0) return

    // §2.78: only the user's own text is ever sent or replaced. Split BEFORE
    // the first refusal so every refusal — including the two raised locally
    // below — is recorded against the string that would have gone on the wire,
    // not against the draft that contains it.
    const split = splitComposeBody(body)

    const refuse = (reason: TranslateDraftRefusalReason) => {
      setPreview(null)
      // The SENT text is recorded WITH the reason: on a draft "the same
      // request" is a pair, because the text is editable and an edit is exactly
      // what makes some of these refusals answerable (see
      // `draftRefusalAllowsRetry`). The pair's second half is `split.own` and
      // not `body`, because `split.own` is what the provider sees.
      setRefusalState({ reason, sentText: split.own })
      setStatus('refused')
    }

    // Gate locally so an empty draft never burns budget on a round trip. Main
    // guards the same way; this only avoids the pointless call.
    if (!hasRewritableText(body)) {
      refuse('empty_input')
      return
    }
    if (!hasRewritableText(split.own)) {
      refuse('no_own_text')
      return
    }

    const requestId = ++requestIdRef.current
    inFlightRef.current.add(requestId)
    setBusy(true)
    setPreview(null)
    setRefusalState(null)
    setStatus('loading')

    void (async () => {
      try {
        const result = await translateRef.current({ accountId: id, text: split.own, targetLang: to })
        if (requestId !== requestIdRef.current) return
        if (result.ok) {
          setPreview({
            original: split.own,
            rewritten: result.translation.translatedText,
            sourceBody: body,
            replacement: joinComposeBody(split, result.translation.translatedText),
          })
          setRefusalState(null)
          setStatus('ready')
          return
        }
        refuse(result.reason)
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        // The contract promises structured refusals, so a throw is an
        // unexpected transport failure — degrade to provider_error and report.
        captureException(err, { source: 'useDraftTranslation.run' })
        refuse('provider_error')
      } finally {
        // The ONE event that frees the bar. `delete` is a no-op when a reset
        // effect already abandoned this call, so a settle can never resurrect
        // occupancy for a draft the form has moved on from.
        inFlightRef.current.delete(requestId)
        setBusy(inFlightRef.current.size > 0)
      }
    })()
  }, [])

  const canRetryFor = useCallback((body: string): boolean => {
    // Nothing refusing ⇒ nothing to suppress. Idle, loading and ready all take
    // this branch, so the button's ordinary enablement is decided entirely by
    // the rules that already own it. It also keeps the split off the hot path:
    // a draft with no refusal on screen never pays for one, and only a refused
    // draft re-splits per render.
    if (!refusalState) return true
    // A different REQUEST is a different question, whatever the previous one was
    // refused for. The comparison is on the own-text half — the exact string
    // `run` would send — so "shorten it and try again" is advice the interface
    // lets the writer follow, while editing the quote or the signature (which
    // the provider never sees) does not re-arm a button whose next press would
    // buy a byte-identical refusal.
    if (refusalState.sentText !== splitComposeBody(body).own) return true
    return draftRefusalAllowsRetry(refusalState.reason)
  }, [refusalState])

  const dismiss = useCallback(() => {
    // Invalidate any in-flight request so a late response cannot re-open a
    // panel the user has just closed. `busy` is deliberately left alone for
    // the same reason as in `setTargetLang`: closing a panel is not the
    // request finishing.
    requestIdRef.current++
    setPreview(null)
    setRefusalState(null)
    setStatus('idle')
  }, [])

  return {
    active: enabled && typeof accountId === 'number',
    status,
    targetLang,
    preview,
    refusal,
    canRun: targetLang !== null,
    busy,
    canRetryFor,
    setTargetLang,
    run,
    dismiss,
  }
}
