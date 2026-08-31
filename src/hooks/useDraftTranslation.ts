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
 * ## Three properties this hook exists to guarantee
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
  /** Record the user's pick for this draft. Never reaches a provider by itself. */
  setTargetLang: (code: TranslateLanguageCode) => void
  /** Explicit user action — the ONLY path that can reach a provider. */
  run: (body: string) => void
  /** Dismiss the preview / refusal and return to idle. */
  dismiss: () => void
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
  const [refusal, setRefusal] = useState<TranslateDraftRefusalReason | null>(null)
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
    setRefusal(null)
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
    setRefusal(null)
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
    setRefusal(null)
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

    const refuse = (reason: TranslateDraftRefusalReason) => {
      setPreview(null)
      setRefusal(reason)
      setStatus('refused')
    }

    // Gate locally so an empty draft never burns budget on a round trip. Main
    // guards the same way; this only avoids the pointless call.
    if (!hasRewritableText(body)) {
      refuse('empty_input')
      return
    }
    // §2.78: only the user's own text is ever sent or replaced.
    const split = splitComposeBody(body)
    if (!hasRewritableText(split.own)) {
      refuse('no_own_text')
      return
    }

    const requestId = ++requestIdRef.current
    inFlightRef.current.add(requestId)
    setBusy(true)
    setPreview(null)
    setRefusal(null)
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
          setRefusal(null)
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

  const dismiss = useCallback(() => {
    // Invalidate any in-flight request so a late response cannot re-open a
    // panel the user has just closed. `busy` is deliberately left alone for
    // the same reason as in `setTargetLang`: closing a panel is not the
    // request finishing.
    requestIdRef.current++
    setPreview(null)
    setRefusal(null)
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
    setTargetLang,
    run,
    dismiss,
  }
}
