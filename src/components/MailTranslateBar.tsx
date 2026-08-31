/**
 * MailTranslateBar — §3.3 B6, the reading-pane translate control.
 *
 * A thin renderer of {@link UseMailTranslationResult}: it owns no translate
 * state, performs no IPC and makes no decision about when to call a provider.
 * Everything it shows is a projection of the hook (CLAUDE.md §5 hotspot policy).
 *
 * Four things this component is responsible for getting right:
 *
 *   1. **Nothing happens without a click.** The only provider-reaching control
 *      is the translate button. There is no auto-banner and no effect here.
 *
 *   2. **The original is always one click away.** Once a translation exists the
 *      button becomes a two-way switch, and switching back never re-requests.
 *
 *   3. **Every caption is correctable.** The source-language picker has two
 *      doors and one shape: it is offered unprompted when the result came back
 *      with no caption, and it is one disclosure click away from a caption that
 *      IS there but that the reader disagrees with (§3.3.B6.f2). Both are
 *      offers over a translation already on screen; neither blocks anything and
 *      neither costs a provider call.
 *
 *   4. **It says what was actually translated.** For an HTML mail, main
 *      translates the cached plain-text projection of the body, not the rendered
 *      markup — so the reader is looking at a translation of something slightly
 *      different from what the pane normally shows them. `sourceIsTextProjection`
 *      comes back on the wire and drives that one line of disclosure; the
 *      component does not infer it.
 *
 * It deliberately renders `.meta-row`s inside the existing `.mail-viewer-meta`
 * block instead of introducing a styled strip of its own: the bar is a small
 * labelled line about the open message, which is exactly what that block is,
 * and B6's renderer slice carries no stylesheet changes.
 */

import { Languages, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UseMailTranslationResult } from '../hooks/useMailTranslation'
import LanguageSelect from './TranslateLanguageSelect'

export type MailTranslateBarProps = {
  /** The hook that owns every piece of state this component draws. */
  state: UseMailTranslationResult
  /**
   * Whether the ORIGINAL body is HTML. Only used to decide whether the
   * plain-text-projection disclosure is worth showing: for a text-only mail the
   * projection IS the message, and the line would be noise.
   */
  originalIsHtml: boolean
}

export default function MailTranslateBar({ state, originalIsHtml }: MailTranslateBarProps) {
  const { t } = useTranslation()

  if (!state.active) return null

  const { status, translation, refusal } = state
  const loading = status === 'loading'
  const ready = status === 'ready' && translation !== null

  return (
    <>
      <div className="meta-row mail-translate-row" data-testid="mail-translate-bar">
        <Languages size={13} aria-hidden="true" />
        <LanguageSelect
          value={state.targetLang}
          onChange={state.setTargetLang}
          ariaLabel={t('mail.translate.targetLabel')}
          testId="mail-translate-target"
        />
        {ready ? (
          <button
            type="button"
            className="mail-translate-action"
            data-testid="mail-translate-toggle"
            aria-pressed={state.showingTranslation}
            onClick={() => {
              if (state.showingTranslation) state.showOriginal()
              else state.showTranslation()
            }}
          >
            {state.showingTranslation
              ? t('mail.translate.showOriginal')
              : t('mail.translate.showTranslation')}
          </button>
        ) : (
          <button
            type="button"
            className="mail-translate-action"
            data-testid="mail-translate-action"
            disabled={loading}
            onClick={() => state.request()}
          >
            {loading ? (
              <>
                <Loader2 size={13} className="spin" aria-hidden="true" />{' '}
                {t('mail.translate.loading')}
              </>
            ) : status === 'refused' ? (
              // After a refusal the same control is a SECOND attempt, and it
              // says so. "Translate" there reads as if nothing had been tried
              // yet, which is exactly the misreading the refusal line above is
              // trying to correct.
              t('mail.translate.retry')
            ) : (
              t('mail.translate.action')
            )}
          </button>
        )}
      </div>

      {ready && state.showingTranslation && (
        <div className="meta-row mail-translate-notice" data-testid="mail-translate-notice">
          <span>
            {translation.sourceLang
              ? t('mail.translate.producedFrom', {
                  source: t(`mail.translate.languages.${translation.sourceLang}`),
                  target: t(`mail.translate.languages.${translation.targetLang}`),
                })
              : t('mail.translate.produced', {
                  target: t(`mail.translate.languages.${translation.targetLang}`),
                })}
            {originalIsHtml && translation.sourceIsTextProjection
              ? ` ${t('mail.translate.textProjection')}`
              : ''}
            {/* The second door into the picker (§3.3.B6.f2): a caption that IS
                there can still be wrong — local detection fails confidently on
                close relatives — and this sits directly on the sentence it
                would correct, inside the same `<span>` so it flows with the
                prose instead of being pushed to the end of the flex row. It is
                a disclosure, not an action: nothing is requested until the
                reader states a language and presses the button below. */}
            {state.canRestateSourceLang && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn-link mail-translate-restate"
                  data-testid="mail-translate-source-restate"
                  aria-expanded={state.sourceChoiceOpen}
                  aria-controls="mail-translate-source-choice"
                  onClick={() => state.toggleSourceChoice()}
                >
                  {t('mail.translate.sourceRestate')}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {status === 'refused' && refusal !== null && (
        <div className="meta-row mail-translate-refusal" data-testid="mail-translate-refusal">
          <span>{t(`mail.translate.refusal.${refusal}`)}</span>
        </div>
      )}

      {/* An OFFER to caption a translation that already exists, not a demand
          (§3.3.B6.f1). Local detection confuses close relatives
          (Russian/Bulgarian) confidently enough that we will not guess a label —
          but the label never reached the model, so it never had any business
          blocking the translation either.

          Everything here is worded and shaped so that nothing reads as a
          condition the user has to satisfy: the translation is already on
          screen and already readable above this block, the explanatory line
          says out loud that naming the language is optional, and the button
          promises a LABEL, not a translation. Answering re-requests, and because
          the cache is keyed on the hash of the source text (the language is not
          part of that key) the same text comes straight back with the user's own
          label — no provider call and nothing to pay for, which is why no
          "this will cost another request" warning belongs here.

          ONE picker, two doors (§3.3.B6.f2): it is shown unprompted when the
          result came back with no caption, and on request when the reader
          disagrees with a caption that is there. The explanatory line differs
          because the situations differ — "we could not name it" versus "name it
          yourself" — but the control, the button and the cost are identical. */}
      {state.sourceChoiceVisible && (
        <>
          <div
            className="meta-row mail-translate-notice"
            data-testid="mail-translate-source-offer"
          >
            <span>
              {state.needsLanguageChoice
                ? t('mail.translate.sourceOffer')
                : t('mail.translate.sourceRestateHint')}
            </span>
          </div>
          <div
            className="meta-row mail-translate-row"
            id="mail-translate-source-choice"
            data-testid="mail-translate-source-choice"
          >
            <LanguageSelect
              value={state.sourceLang}
              onChange={state.setSourceLang}
              ariaLabel={t('mail.translate.sourceLabel')}
              testId="mail-translate-source"
              placeholder={t('mail.translate.sourcePlaceholder')}
            />
            {/* Inert while the choice would change nothing — no language stated,
                or the same one the caption already says. The hook decides that;
                the component must not re-derive it, or the two answers drift. */}
            <button
              type="button"
              className="mail-translate-action"
              data-testid="mail-translate-source-apply"
              disabled={!state.canApplySourceLang}
              onClick={() => state.request()}
            >
              {t('mail.translate.sourceApply')}
            </button>
          </div>
        </>
      )}
    </>
  )
}
