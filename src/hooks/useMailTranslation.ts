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
 * ## Four properties this hook exists to guarantee
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
