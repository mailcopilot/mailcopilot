import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TranslateLanguageCode,
  TranslateMessageRequest,
  TranslateMessageResult,
  TranslateRefusalReason,
  TranslatedMessage,
} from '@mailcopilot/types'
// Imported BY PATH rather than through the `@mailcopilot/core` barrel: the
// barrel does not re-export `language.ts` (see its header — main pairs it with
// franc's trigram table, which has no business in the renderer bundle). Only
// the code table and the type guard are used here; nothing in this module
// detects anything.
import { isTranslateLanguageCode } from '../../packages/core/language'
import { captureException } from '../sentry'

/**
 * useMailTranslation — §3.3 B6 "translate this message", the renderer side.
 *
 * Owns the whole state machine of the reading-pane translate bar: which message
 * it is scoped to, which target language is selected, whether a request is in
 * flight, what came back, and whether the viewer is currently showing the
 * ORIGINAL or the TRANSLATION. `MailTranslateBar` and `MailBodyContent` render
 * this hook's output and hold no translate state of their own (CLAUDE.md §5
 * hotspot policy — App.tsx is wiring only).
 *
 * ## Five properties this hook exists to guarantee
 *
 * 1. **Never automatic.** There is no effect that calls the provider. The only
 *    path to `ai:translate:message` is {@link UseMailTranslationResult.request},
 *    which is reachable only from a click. An automatic translate-on-open would
 *    spend the user's own provider key every time a foreign-language mail
 *    lands — the "hidden spend" Gmail's auto-banner accepts and B6 deliberately
 *    does not.
 *
 * 2. **The toggle belongs to ONE message.** Everything resets when the message
 *    identity changes, so a translation produced for one message can never be
 *    shown under another, and the original/translation switch cannot "stick"
 *    onto the next mail the user opens. The reset is keyed on the identity
 *    string, not on an object reference, so an unrelated re-render that rebuilds
 *    the `message` prop does not throw away a translation the user is reading.
 *
 * 3. **A late response never lands on the wrong message.** A monotonic token is
 *    bumped synchronously whenever the scoped message changes; a response whose
 *    token no longer matches is dropped. Same discipline as `useThreadSummary`.
 *
 * 4. **The result is TEXT.** `translatedText` is carried through untouched and
 *    handed to the renderer as a React text child. There is no HTML half in the
 *    contract and nothing here builds one: model output derived from untrusted
 *    mail must never reach `dangerouslySetInnerHTML` or an iframe `srcDoc`.
 *
 * 5. **A second press is visible, and a useless one is never offered**
 *    (2026-08-31). Requests can cost the reader money and the provider may
 *    refuse for the same reason every time, so a repeat can repaint a
 *    byte-identical screen — which is exactly what a dead button looks like. Two
 *    values leave the hook to close that: `attempts`, which moves on every press
 *    this hook SENDS, and `canRetry`, which is false for the refusals that have
 *    no realistic chance of answering differently until something outside this
 *    request changes. The bar draws no button in that case rather than a live
 *    one whose outcome we already expect.
 *
 * ## What the renderer is NOT allowed to do, and does not
 *
 * The request carries a message REF plus a language identifier from a closed
 * sixteen-value enum — never body text, never a model instruction. Main reads
 * the text from the local SQLite cache and builds the prompt from a fixed table
 * (§3.3 B4 invariant, restated for B6). The `sourceLang` field CORRECTS THE
 * CAPTION and never reaches the prompt — since §3.3.B6.f1 it unlocks nothing,
 * because detection never gated the translation in the first place.
 *
 * ## Every caption is correctable, not only a missing one (§3.3.B6.f2)
 *
 * Detection is local (`franc` trigrams) and its documented failure mode is
 * CONFIDENT and WRONG, not silent: on business mail the measured margin between
 * the right answer and a close relative is thin enough that a wrong label is a
 * normal outcome, not an exotic one. An interface that offers the picker only
 * when the label is ABSENT therefore leaves exactly the measured failure mode
 * unfixable — the reader sees an authoritative "machine translation from
 * Bulgarian" over their Russian mail and has no ordinary way to say otherwise,
 * while `TranslateMessageRequest.sourceLang` is documented as precisely the
 * field "a user who disagrees with that caption" states themselves.
 *
 * So there are two doors into the same picker, and they never both show:
 *
 *   - {@link UseMailTranslationResult.needsLanguageChoice} — the label is
 *     missing, so the picker is offered unprompted (§3.3.B6.f1).
 *   - {@link UseMailTranslationResult.canRestateSourceLang} — the label is
 *     there, so the picker is one disclosure click away from the caption it
 *     would correct.
 *
 * Both are OFFERS. The translation is on screen before either appears and stays
 * on screen while they are open; neither blocks anything. Answering re-requests,
 * and because the translation cache is keyed on the hash of the SOURCE TEXT —
 * the language is not part of that key — the same text comes straight back with
 * the user's own label. No provider call, nothing to pay for, which is why
 * nothing here warns about a second charge.
 */

/** What the viewer is currently showing for the scoped message. */
export type MailTranslationView = 'original' | 'translation'

export type MailTranslationStatus = 'idle' | 'loading' | 'ready' | 'refused'

/** The message a translation is scoped to. A REF — never any body text. */
export type MailTranslationTarget = {
  accountId: number
  folder: string
  uid: number
}

export type UseMailTranslationParams = {
  /** Active message, or `null` when nothing is open. */
  message: MailTranslationTarget | null
  /**
   * Per-account opt-in (`settings.aiTranslateEnabled["<accountId>"]`, default
   * OFF), read by the caller. When false the hook is inert: no bar, no IPC.
   *
   * Main enforces the same gate and answers `opt_out`, which this hook still
   * renders (the setting can change between paint and click) — gating here only
   * avoids offering an action that is known to refuse.
   */
  enabled: boolean
  /**
   * Interface locale (`i18n.language`). Seeds the default target language, so
   * "translate" means "into the language this person reads the app in" without
   * asking. Mapped through {@link translateLanguageFromUiLocale}.
   */
  uiLocale: string
  /**
   * Injectable IPC runner (tests). Defaults to the real `window.api` bridge.
   */
  translate?: (req: TranslateMessageRequest) => Promise<TranslateMessageResult>
}

export type UseMailTranslationResult = {
  /** Whether the translate bar should render at all. */
  active: boolean
  status: MailTranslationStatus
  /** The produced translation while `status === 'ready'`, else null. */
  translation: TranslatedMessage | null
  /** Structured refusal while `status === 'refused'`, else null. */
  refusal: TranslateRefusalReason | null
  /**
   * How many requests this hook has SENT for the message and target currently
   * in view. Counted at FIRE TIME, not on the answer.
   *
   * ## What this number is, and what it is deliberately not
   *
   * It is a count of PRESSES THAT LEFT THE RENDERER. It is NOT a count of calls
   * the provider was paid for, and nothing here may describe it as one: main is
   * free to refuse the request before any provider is contacted — no provider
   * configured, per-account consent off, budget exhausted, the input cap, or a
   * cache hit that answers without spending anything. The renderer never learns
   * which of those happened; the wire contract carries a refusal reason, not a
   * billing verdict. Claiming spend from here would be inventing knowledge we
   * do not have (CLAUDE.md §5 "кто владеет правдой") — the same defect class as
   * pricing someone else's ledger from our own guess.
   *
   * Making it a true spend count would mean main reporting, per response,
   * whether the call reached a provider — a wire-contract change, not a
   * renderer change. Until then the honest reading is "how many times you asked".
   *
   * It exists because a repeat that refuses for the same reason repaints a
   * byte-identical screen, and the reader cannot tell that from a button that
   * did nothing (2026-08-31 incident: seven clicks in three seconds, seven
   * requests that did reach the provider and were billed, no visible change). A
   * number that moves on every press is the smallest honest answer to "did my
   * click do anything".
   *
   * Resets exactly where results reset: a new message or a new target language
   * is a new question, so its attempts start at zero.
   */
  attempts: number
  /**
   * Whether offering another attempt is honest for the CURRENT refusal.
   *
   * False for refusals that have no realistic chance of answering differently
   * until something outside this request changes, so the bar renders no button
   * at all rather than a live control whose outcome we already expect. A
   * dead-looking button and a button that is genuinely dead are the same defect
   * wearing different clothes; the answer to both is to not draw it.
   */
  canRetry: boolean
  /** Currently selected target language. */
  targetLang: TranslateLanguageCode
  /** User-stated source language. Corrects the caption; never gates a request. */
  sourceLang: TranslateLanguageCode | null
  /**
   * True when a translation came back with NO source-language caption, i.e. the
   * local detector would not name the language (or named one outside our set).
   *
   * An OFFER, not a demand (§3.3.B6.f1). Until the fix wave this was a refusal
   * the user had to answer before any translation existed: main returned
   * `undetermined_language` and nothing was translated. That gate is gone — the
   * source language never reached the model, so requiring it bought a second
   * click for an identical answer. The translation is now already on screen and
   * this only offers to label it; answering re-requests, which is served from
   * the cache with the user's own label applied and costs nothing.
   */
  needsLanguageChoice: boolean
  /**
   * True when a translation carries a source-language caption that the user
   * could disagree with — i.e. the correction door described in the module
   * docblock is worth offering (§3.3.B6.f2).
   *
   * Requires the translation to be the thing currently ON SCREEN: the control
   * is a correction of a caption, and the caption only exists next to the
   * translation. Gating it here rather than in the component keeps "the flag is
   * true" and "the control is visible" the same statement, so there is no state
   * where the offer is advertised and nothing renders it.
   */
  canRestateSourceLang: boolean
  /** Whether the disclosure opened by {@link toggleSourceChoice} is expanded. */
  sourceChoiceOpen: boolean
  /**
   * True when the source-language picker should be on screen — through either
   * door: offered unprompted because the caption is missing, or opened by the
   * reader to correct a caption that is present.
   */
  sourceChoiceVisible: boolean
  /**
   * True when applying the stated source language would actually CHANGE the
   * caption. False while nothing is chosen, and false when the choice already
   * equals the caption on screen — a control that re-runs the request to
   * produce the identical label is a control that does nothing, and it should
   * look inert rather than spend a click to prove it.
   */
  canApplySourceLang: boolean
  /** True when the body area must render the translation instead of the original. */
  showingTranslation: boolean
  /** Select a target language. Discards a translation made for a different one. */
  setTargetLang: (code: TranslateLanguageCode) => void
  /** State the source language, to caption a translation that came back without one. */
  setSourceLang: (code: TranslateLanguageCode) => void
  /**
   * Open or collapse the picker over a translation that already has a caption.
   * Pure disclosure: it reaches no provider and changes no label by itself.
   */
  toggleSourceChoice: () => void
  /** Explicit user action — the ONLY path that can reach a provider. */
  request: () => void
  /** Switch the viewer back to the original message. One click, always available. */
  showOriginal: () => void
  /** Switch the viewer back to an already-produced translation. */
  showTranslation: () => void
}

/**
 * Interface locale (`en`, `ru-RU`, `pt-BR`, …) → default target language.
 *
 * Falls back to English for anything outside the sixteen-code set, which is the
 * honest default: the user can always pick another target in the bar, and a
 * silent no-op would be worse than a visible wrong-but-editable choice.
 */
export function translateLanguageFromUiLocale(locale: string): TranslateLanguageCode {
  const base = typeof locale === 'string' ? locale.slice(0, 2).toLowerCase() : ''
  return isTranslateLanguageCode(base) ? base : 'en'
}

/**
 * Identity of the scoped message, used as the reset key.
 *
 * `\u0000`-framed rather than `:`-joined: IMAP folder names legitimately contain
 * colons, and a colliding key would let two different messages share one
 * translation state — precisely the leak property 2 above forbids.
 *
 * Always spelled as the `\u0000` escape, never as a raw byte: a literal NUL in
 * the source makes this file binary to `grep` and `git diff`, and it would drop
 * out of exactly the audits that need to see the IPC call below.
 */
function targetKey(message: MailTranslationTarget | null): string | null {
  if (!message) return null
  return `${message.accountId}\u0000${message.folder}\u0000${message.uid}`
}

/**
 * Whether another attempt at THIS refusal could answer differently.
 *
 * The rule is one question asked per reason: is a second press, made right now
 * with nothing else changed, REASONABLY LIKELY to produce a different result?
 * Where the answer is no, the bar draws no button — because a control whose
 * outcome we can already predict is a poor choice to offer, and here it is not a
 * free one either: a press that main does not refuse before dispatch is a fresh
 * billed request against the reader's own provider key.
 *
 * The bar for suppression is PROBABLE, not PROVEN, and the difference is worth
 * writing down because the strong claim would be false. Nothing here can know
 * that a provider is deterministic — several of these calls go out with a
 * non-zero temperature, so a repeat CAN come back different. What the refusal
 * proves is that the LAST answer hit the ceiling, not that every future one
 * must. We suppress because a repeat is very likely to reproduce the same
 * refusal AND COSTS MONEY TO FIND OUT, not because a different outcome is
 * impossible.
 *
 * Exhaustive over `TranslateRefusalReason` with a `never` guard, so a reason
 * added to the wire contract cannot quietly inherit someone else's verdict.
 *
 *   answer_too_long — NO. The message and the output ceiling are exactly what
 *     they were a moment ago, so a repeat is asking the same model for the same
 *     thing under the same limit — very likely the same refusal, at full price.
 *     This is the case the 2026-08-31 incident was made of.
 *   too_long — NO. The input cap is measured before any call; the same text
 *     measures the same.
 *   opt_out — NO. Turning the setting on flips `enabled`, which resets this hook
 *     to idle and removes the refusal along with the button; so a press while
 *     the refusal is still on screen is a press against an unchanged setting.
 *   budget — YES. The cap belongs to a period that rolls, and it can also be
 *     raised in Settings without anything here resetting.
 *   no_provider — YES. Configuring a provider changes nothing in this hook's
 *     state, so the refusal stays on screen and the retry is exactly the way
 *     back.
 *   empty_input — YES. The body is still downloading; its own copy tells the
 *     reader to try once it has arrived.
 *   provider_error — YES. By construction this is now the reason we have NO
 *     explanation for, and an unexplained failure may well be transient. That is
 *     the whole value of having split `answer_too_long` out of it.
 */
function refusalAllowsRetry(reason: TranslateRefusalReason): boolean {
  switch (reason) {
    case 'answer_too_long':
    case 'too_long':
    case 'opt_out':
      return false
    case 'budget':
    case 'no_provider':
    case 'empty_input':
    case 'provider_error':
      return true
    default: {
      const exhaustive: never = reason
      void exhaustive
      // An unknown reason from a newer main is not evidence that retrying is
      // pointless, and refusing to draw the button would strand the reader with
      // no way forward at all. Offer it.
      return true
    }
  }
}

/** Default IPC runner — invokes the whitelisted `ai:translate:message` channel. */
async function defaultTranslate(req: TranslateMessageRequest): Promise<TranslateMessageResult> {
  return (await window.api.invoke('ai:translate:message', req)) as TranslateMessageResult
}

export function useMailTranslation({
  message,
  enabled,
  uiLocale,
  translate = defaultTranslate,
}: UseMailTranslationParams): UseMailTranslationResult {
  const defaultTarget = translateLanguageFromUiLocale(uiLocale)

  const [status, setStatus] = useState<MailTranslationStatus>('idle')
  const [translation, setTranslation] = useState<TranslatedMessage | null>(null)
  const [refusal, setRefusal] = useState<TranslateRefusalReason | null>(null)
  const [targetLang, setTargetLangState] = useState<TranslateLanguageCode>(defaultTarget)
  const [sourceLang, setSourceLangState] = useState<TranslateLanguageCode | null>(null)
  // Disclosure state of the SECOND door into the picker (§3.3.B6.f2) — the one
  // over a translation that already carries a caption. Purely presentational:
  // it never appears in a request and cannot reach a provider. The first door
  // (`needsLanguageChoice`) is derived, not stored, because it is a property of
  // the result rather than a thing the reader opened.
  const [sourceChoiceOpen, setSourceChoiceOpen] = useState(false)
  const [view, setView] = useState<MailTranslationView>('original')
  // Requests SENT for the question currently in view — presses that left the
  // renderer, not calls we know were billed (see `attempts` on the result type).
  // State rather than a derived value because it is the only thing on screen
  // that is guaranteed to change when a repeat produces the identical refusal.
  const [attempts, setAttempts] = useState(0)

  const translateRef = useRef(translate)
  translateRef.current = translate
  // The request the click handler must read at fire time. Kept in a ref so
  // `request` stays referentially stable and does not re-create every keystroke
  // in the language selects.
  const paramsRef = useRef({ message, targetLang, sourceLang, enabled, translation })
  paramsRef.current = { message, targetLang, sourceLang, enabled, translation }

  // Mirrors `sourceChoiceOpen` for the toggle, which must stay referentially
  // stable (it is read from a memoized component tree). Same discipline as
  // `paramsRef`: state for rendering, ref for reading at event time.
  const sourceChoiceOpenRef = useRef(sourceChoiceOpen)
  sourceChoiceOpenRef.current = sourceChoiceOpen

  // Monotonic token — bumped synchronously by EVERY event that makes an
  // in-flight response no longer an answer to the current question, so that
  // response is dropped rather than painted under whatever is on screen now
  // (property 3). Three such events exist and all three bump it: the scoped
  // message changed, the target language changed, and the feature was switched
  // off. Clearing the visible state without bumping the token is not enough —
  // the state is only clear until the stale promise resolves and writes into it.
  const requestIdRef = useRef(0)

  const key = targetKey(message)
  const active = enabled && key !== null

  // Reset on message change, and on the per-account opt-in being switched off.
  //
  // Keyed on the identity STRING rather than the object: an unrelated re-render
  // that rebuilds the `message` prop must not discard a translation the user is
  // currently reading.
  //
  // `enabled` is a dependency because turning the feature off in Settings has to
  // put the reading pane back on the ORIGINAL. The bar is what offers "show
  // original", and the bar is gone the moment `active` goes false — so a
  // translation left in state would keep `showingTranslation` true, keep
  // `MailBodyContent` painting model output over the message, and leave no
  // one-click way back. Off means off, in the body area too.
  useEffect(() => {
    const tokenRef = requestIdRef
    tokenRef.current++
    setStatus('idle')
    setTranslation(null)
    setRefusal(null)
    setSourceLangState(null)
    setSourceChoiceOpen(false)
    setView('original')
    setAttempts(0)
  }, [key, enabled])

  // Follow the interface language until the user overrides the target for this
  // message. Changing the app language mid-session should change what
  // "translate" means; it must not silently rewrite an already-produced
  // translation, which is why this only moves the SELECTION and the reset above
  // is what clears results.
  useEffect(() => {
    setTargetLangState(defaultTarget)
  }, [defaultTarget, key])

  const setTargetLang = useCallback((code: TranslateLanguageCode) => {
    // Compared through the params ref rather than inside a state updater: an
    // updater must stay pure (React may run it twice), and dropping the result
    // is a side effect.
    if (paramsRef.current.targetLang === code) return
    // Invalidate first. A request that is STILL IN FLIGHT was asked in the old
    // target language, so its answer is as wrong here as an answer for another
    // message would be: without this bump, clearing the state below only holds
    // until that promise resolves, and it would then land as `ready` under the
    // newly selected language — a German translation captioned "into Japanese".
    // The user does not have to start a new request for this to happen; they
    // only have to wait.
    requestIdRef.current++
    setTargetLangState(code)
    // A result produced for another target is not an answer to this one. Drop
    // it and fall back to the original rather than leaving a language label
    // that disagrees with the text underneath it.
    setTranslation(null)
    setRefusal(null)
    setStatus('idle')
    // A different target is a different question, so its attempt count starts
    // over. Carrying the old one would report attempts at something the reader
    // never asked for.
    setAttempts(0)
    // The disclosure belonged to the caption of the result just dropped. Left
    // standing it would hang under a target selection with nothing to correct.
    setSourceChoiceOpen(false)
    setView('original')
  }, [])

  const setSourceLang = useCallback((code: TranslateLanguageCode) => {
    setSourceLangState(code)
  }, [])

  const toggleSourceChoice = useCallback(() => {
    const wasOpen = sourceChoiceOpenRef.current
    setSourceChoiceOpen(!wasOpen)
    if (wasOpen) return
    // Opening seeds the picker with the caption currently on screen, so the
    // control starts at what we are claiming and the reader changes it — a
    // blank "choose a language" would make the correction look like a fresh
    // question rather than a disagreement with the label above it. An answer
    // the reader has already given wins over the caption: it is the newer
    // statement of the two.
    const current = paramsRef.current
    setSourceLangState(current.sourceLang ?? current.translation?.sourceLang ?? null)
  }, [])

  const showOriginal = useCallback(() => setView('original'), [])
  const showTranslation = useCallback(() => setView('translation'), [])

  const request = useCallback(() => {
    const { message: target, targetLang: to, sourceLang: from, enabled: on } = paramsRef.current
    if (!on || !target) return

    const requestId = ++requestIdRef.current
    setStatus('loading')
    setRefusal(null)
    // Counted HERE, past the early return and before the await: the fact the
    // reader needs is that this press was SENT, which is true the moment the
    // request is issued and stays true whether the answer arrives, refuses, or
    // is dropped as stale. Counting on the answer instead would leave the number
    // still during the one situation it exists for. It is deliberately NOT
    // moved to the answer in order to count billed calls either — the answer
    // does not say whether one happened (see `attempts` on the result type).
    setAttempts(n => n + 1)

    const req: TranslateMessageRequest = {
      accountId: target.accountId,
      folder: target.folder,
      uid: target.uid,
      targetLang: to,
      ...(from ? { sourceLang: from } : {}),
    }

    void (async () => {
      try {
        const result = await translateRef.current(req)
        if (requestId !== requestIdRef.current) return
        if (result.ok) {
          setTranslation(result.translation)
          setRefusal(null)
          setStatus('ready')
          // The answer carries the caption the disclosure existed to fix, so it
          // collapses. Leaving it open would show a picker already equal to the
          // new label, with its own button inert — an open control with nothing
          // left to do.
          setSourceChoiceOpen(false)
          // Producing a translation is what the user asked for, so show it.
          // Going back is one click (`showOriginal`) and never re-requests.
          setView('translation')
          return
        }
        setTranslation(null)
        setRefusal(result.reason)
        setStatus('refused')
        setSourceChoiceOpen(false)
        setView('original')
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        // The contract promises structured refusals, so a throw is an
        // unexpected transport failure. Degrade to the graceful refusal copy
        // instead of surfacing a crash in the reading pane.
        captureException(err, { source: 'useMailTranslation.request' })
        setTranslation(null)
        setRefusal('provider_error')
        setStatus('refused')
        setSourceChoiceOpen(false)
        setView('original')
      }
    })()
  }, [])

  // One narrowed value the four caption-related flags are all derived from, so
  // they cannot disagree about whether a translation exists.
  const readyTranslation = status === 'ready' ? translation : null
  const needsLanguageChoice = readyTranslation !== null && readyTranslation.sourceLang === null
  const showingTranslation = view === 'translation' && translation !== null
  const sourceChoiceVisible =
    needsLanguageChoice || (readyTranslation !== null && sourceChoiceOpen)

  return {
    active,
    status,
    translation,
    refusal,
    attempts,
    // Only ever true while something is actually refusing: `canRetry` answers
    // "should the button be drawn for THIS refusal", so with no refusal on
    // screen there is nothing for it to be about.
    canRetry: status === 'refused' && refusal !== null && refusalAllowsRetry(refusal),
    targetLang,
    sourceLang,
    needsLanguageChoice,
    // The two doors are mutually exclusive by construction (`=== null` vs
    // `!== null` on the same caption), so the reader is never offered the same
    // picker twice.
    canRestateSourceLang:
      readyTranslation !== null && readyTranslation.sourceLang !== null && showingTranslation,
    sourceChoiceOpen,
    // A disclosure flag alone can never put the picker on screen: without a
    // ready translation there is no caption to correct, and the settle paths
    // above close it anyway. Requiring both keeps a stale `true` inert.
    sourceChoiceVisible,
    canApplySourceLang:
      sourceChoiceVisible &&
      sourceLang !== null &&
      sourceLang !== (readyTranslation?.sourceLang ?? null),
    showingTranslation,
    setTargetLang,
    setSourceLang,
    toggleSourceChoice,
    request,
    showOriginal,
    showTranslation,
  }
}
