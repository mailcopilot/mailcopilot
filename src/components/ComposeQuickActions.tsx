/**
 * ComposeQuickActions — B4 Compose Quick Actions toolbar.
 *
 * A thin toolbar rendered above the compose body: four preset buttons
 * (Improve / Shorter / Formal / Grammar), an inline loading/refusal status, and
 * the before/after diff preview. All logic lives in `useQuickActions`; this
 * component wires the current draft text + caret in, and applies the user's
 * Replace/Insert choice out via callbacks the parent owns. No hardcoded copy.
 *
 * The parent (Compose) keeps ownership of the textarea state and passes:
 *   - `text` — current draft body (captured at click time to send to backend);
 *   - `getCaret` — current caret index (read lazily on Insert);
 *   - `onReplace(next)` / `onInsert(rewritten, caret)` — mutation callbacks.
 * This keeps the "no auto-substitution" invariant: the body only changes when
 * the parent's callback runs after an explicit Replace/Insert.
 *
 * Two §2.78 guarantees are enforced at this seam:
 *   - Replace applies `preview.replacement` (rewritten own part + the quoted
 *     original / forwarded message / signature carried through verbatim), never
 *     the bare model output over the whole body.
 *   - Replace is refused — button disabled plus a handler guard — when the body
 *     changed after the rewrite was requested, so text typed during generation
 *     cannot disappear. Insert at cursor stays available because it splices
 *     into the CURRENT body and can therefore lose nothing.
 *
 * The three actions on this bar (rewrite presets, proofread, translate) own
 * independent state machines that cannot see each other, so this component is
 * the one place where "the draft is occupied" can be decided: while ANY of them
 * has a request in flight or a review panel open, the other two are disabled
 * (`isBlockedByOtherAction`). Without that, two review panels could stack over
 * the same body and two paid requests could answer overlapping questions, with
 * the second panel guaranteed stale on arrival.
 *
 * §3.3 B7 adds a second, independent action to the same bar: a proofread check
 * that returns a LIST of individually acceptable edits (`useProofread` +
 * `ProofreadPanel`). It is rendered only for an account that opted in, it has
 * its own refusal line, and it never participates in sending — the send path
 * does not read any of its state (the corrector is informational and can never
 * block a send).
 */

import { useTranslation } from 'react-i18next'
import { Sparkles, Loader2, SpellCheck, Languages } from 'lucide-react'
import type { TranslateDraftRefusalReason, TranslateLanguageCode } from '@mailcopilot/types'
import {
  QUICK_ACTION_PRESETS,
  quickActionLabelKey,
  hasRewritableText,
  insertAtCaret,
  isBlockedByOtherAction,
  isPreviewStale,
  type ComposeAiActivity,
  type ProofreadDisplayRefusal,
  type QuickActionDisplayRefusal,
} from '../utils/quickActions'
import { useProofread, useQuickActions } from '../hooks/useQuickActions'
import { useDraftTranslation } from '../hooks/useDraftTranslation'
import { ProofreadPanel, QuickActionDiff } from './QuickActionDiff'
import TranslateLanguageSelect from './TranslateLanguageSelect'

export type ComposeQuickActionsProps = {
  /** Account authoring the draft; `null` disables the toolbar. */
  accountId: number | null
  /** Current draft body text. */
  text: string
  /** Whether the compose is mid-send (disables the toolbar). */
  disabled?: boolean
  /**
   * §3.3 B7: whether the per-account AI Proofread opt-in
   * (`settings.aiProofreadEnabled["<accountId>"]`) is on for this account.
   * Default OFF — the Check button is not rendered at all when it is off, so
   * the feature is invisible until it is asked for. Main gates independently
   * and refuses with `not_enabled`; this is UX, not the security boundary.
   */
  proofreadEnabled?: boolean
  /**
   * §3.3 B6 (draft side): whether the per-account AI Translate opt-in
   * (`settings.aiTranslateEnabled["<accountId>"]`) is on for this account. The
   * control is not rendered at all when it is off. Main gates the channel
   * independently and refuses with `opt_out` — defence in depth, not a
   * duplicate: the setting can change between paint and click.
   */
  translateEnabled?: boolean
  /**
   * §3.3 B6: the language this reply is probably meant to be written in, minted
   * by MAIN from the message being replied to and carried in `ComposeInit`. A
   * suggestion — it pre-fills the picker and starts nothing.
   */
  suggestedTargetLang?: TranslateLanguageCode | null
  /**
   * Generation of the compose form — a counter the parent bumps on every
   * `compose:init`. An increment means the window was reused for another
   * message, which resets ALL THREE machines on this bar: the rewrite presets,
   * the proofreader and the translation (including its remembered target
   * language — property 3 in `useDraftTranslation`). One rule, one key: see
   * `COMPOSE_GENERATION_RESET_NOTE` in `useQuickActions.ts`.
   *
   * Deliberately NOT the draft's storage id: that resolves asynchronously,
   * well after the toolbar is interactive, and a pick or a paid request made
   * in the gap was wiped by its arrival.
   *
   * REQUIRED, with no default (§3.3 B6.f3). All three hooks below take it as a
   * mandatory parameter precisely so a caller cannot forget it; an optional
   * prop with a `= 0` default put that back — a future call site would compile
   * clean and silently get three machines that never reset, which is the
   * hung-toolbar defect the reset was introduced to fix.
   */
  composeGeneration: number
  /** Lazily read the current caret index in the body textarea. */
  getCaret: () => number
  /** Replace the whole draft body with `next`. */
  onReplace: (next: string) => void
  /** Insert `text` at `caret`, returning the new body + caret to the parent. */
  onInsert: (next: string, caret: number) => void
}

/**
 * Map a surfaced refusal reason to its localized inline message key.
 *
 * NOTE for future edits: the `default:` arm means a NEW reason added to
 * `QuickActionDisplayRefusal` still type-checks while silently rendering the
 * generic provider-error copy (that is exactly how `too_long` was mis-shown in
 * §2.78 wave A). Every reason therefore has an explicit arm AND a test; the
 * default is a runtime fallback for an unknown wire value only.
 */
function refusalMessageKey(reason: QuickActionDisplayRefusal): string {
  switch (reason) {
    case 'budget':
      return 'ai.quickAction.refusal.budget'
    case 'no_provider':
      return 'ai.quickAction.refusal.noProvider'
    case 'provider_error':
      return 'ai.quickAction.refusal.providerError'
    case 'empty_input':
      return 'ai.quickAction.refusal.emptyInput'
    case 'too_long':
      return 'ai.quickAction.refusal.tooLong'
    case 'no_own_text':
      return 'ai.quickAction.refusal.noOwnText'
    default:
      return 'ai.quickAction.refusal.providerError'
  }
}

/**
 * Map a proofread refusal to its localized inline message key.
 *
 * Exhaustive over `ProofreadDisplayRefusal` — the `default:` arm is a runtime
 * fallback for an unknown wire value only. `not_enabled` deliberately has its
 * own arm and its own copy: the actionable fix is a toggle in Settings, not a
 * provider key, and collapsing it into the provider-error line is exactly the
 * mistake §3.3.B4.f3(a) records.
 */
function proofreadRefusalMessageKey(reason: ProofreadDisplayRefusal): string {
  switch (reason) {
    case 'not_enabled':
      return 'ai.quickAction.proofread.refusal.notEnabled'
    case 'no_own_text':
      return 'ai.quickAction.proofread.refusal.noOwnText'
    case 'empty_input':
      return 'ai.quickAction.proofread.refusal.emptyInput'
    case 'too_long':
      return 'ai.quickAction.proofread.refusal.tooLong'
    case 'budget':
      return 'ai.quickAction.proofread.refusal.budget'
    case 'no_provider':
      return 'ai.quickAction.proofread.refusal.noProvider'
    case 'provider_error':
      return 'ai.quickAction.proofread.refusal.providerError'
    default:
      return 'ai.quickAction.proofread.refusal.providerError'
  }
}

/**
 * Map a draft-translation refusal to its localized inline message key.
 *
 * Exhaustive over `TranslateDraftRefusalReason` — seven reasons, seven arms,
 * deliberately NOT collapsed into a shared "the provider failed" line
 * (§3.3.B4.f3(a)): each one has a different actionable answer (raise the
 * budget, add a provider, turn the setting on, write something above the
 * quote, shorten the draft, try again). The `default:` arm exists only for an
 * unknown value from a rogue/older main.
 */
function translateRefusalMessageKey(reason: TranslateDraftRefusalReason): string {
  switch (reason) {
    case 'budget':
      return 'ai.quickAction.translate.refusal.budget'
    case 'no_provider':
      return 'ai.quickAction.translate.refusal.noProvider'
    case 'provider_error':
      return 'ai.quickAction.translate.refusal.providerError'
    case 'empty_input':
      return 'ai.quickAction.translate.refusal.emptyInput'
    case 'too_long':
      return 'ai.quickAction.translate.refusal.tooLong'
    case 'opt_out':
      return 'ai.quickAction.translate.refusal.optOut'
    case 'no_own_text':
      return 'ai.quickAction.translate.refusal.noOwnText'
    default:
      return 'ai.quickAction.translate.refusal.providerError'
  }
}

export function ComposeQuickActions({
  accountId,
  text,
  disabled = false,
  proofreadEnabled = false,
  translateEnabled = false,
  suggestedTargetLang = null,
  composeGeneration,
  getCaret,
  onReplace,
  onInsert,
}: ComposeQuickActionsProps) {
  const { t } = useTranslation()
  // All three machines take the SAME reset key. They have to: this component
  // makes them dependent on each other through `isBlockedByOtherAction`, so a
  // request left hanging in any one of them disables the other two — and a
  // state that outlived `compose:init` would keep doing so for the next
  // message the reused window writes.
  const qa = useQuickActions({ accountId, composeGeneration })
  const pr = useProofread({ accountId, composeGeneration })
  const tr = useDraftTranslation({
    accountId,
    enabled: translateEnabled,
    suggestedTargetLang,
    composeGeneration,
  })

  const canRun = accountId != null && !disabled && hasRewritableText(text)
  // The check is stale as soon as the body differs from the snapshot it was
  // computed over: every offset indexes into that exact string (§2.78 AC-h).
  const proofreadStale = pr.review != null && isPreviewStale(pr.review, text)

  // The single owner of "this draft is occupied" (§3.3 B6.f-renderer). The
  // three hooks below cannot see each other, so without one place that reads
  // all three, a second action can start over an open review panel: two paid
  // requests answering overlapping questions and two panels stacked on the
  // same body. `isBlockedByOtherAction` never blocks an action with its own
  // activity, so re-running a preset while its own diff is open is unchanged.
  const activity: ComposeAiActivity = {
    rewrite: qa.status === 'loading' || (qa.status === 'ready' && qa.preview != null),
    proofread: pr.status === 'loading' || (pr.status === 'ready' && pr.review != null),
    // `tr.busy`, NOT `tr.status === 'loading'` (§3.3 B6.f3): changing the target
    // language mid-flight drops the ANSWER and returns the status to idle,
    // while the call it invalidated is still out and still being billed.
    // Reading the status here freed the whole bar during that window.
    translate: tr.busy || (tr.status === 'ready' && tr.preview != null),
  }

  return (
    <div className="compose-quick-actions" data-testid="compose-quick-actions">
      <div className="compose-quick-actions-bar">
        <Sparkles size={14} className="compose-quick-actions-icon" aria-hidden="true" />
        {QUICK_ACTION_PRESETS.map(preset => {
          const isRunning = qa.status === 'loading' && qa.activePreset === preset
          return (
            <button
              key={preset}
              type="button"
              className="compose-quick-action-btn"
              data-testid={`compose-quick-action-${preset}`}
              disabled={!canRun || qa.status === 'loading' || isBlockedByOtherAction(activity, 'rewrite')}
              aria-busy={isRunning}
              onClick={() => qa.run(preset, text)}
              title={t(quickActionLabelKey(preset))}
            >
              {isRunning ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : null}
              {t(quickActionLabelKey(preset))}
            </button>
          )
        })}
        {/* §3.3 B7: rendered only for an account that opted in. Sits with the
            rewrite presets because it acts on the same draft, but it is not a
            fifth preset — it returns a list of individually acceptable edits,
            not one rewritten string. */}
        {proofreadEnabled && (
          <button
            type="button"
            className="compose-quick-action-btn compose-proofread-btn"
            data-testid="compose-proofread-run"
            disabled={!canRun || pr.status === 'loading' || isBlockedByOtherAction(activity, 'proofread')}
            aria-busy={pr.status === 'loading'}
            onClick={() => pr.run(text)}
            title={t('ai.quickAction.proofread.button')}
          >
            {pr.status === 'loading'
              ? <Loader2 size={13} className="spin" aria-hidden="true" />
              : <SpellCheck size={13} aria-hidden="true" />}
            {pr.status === 'loading'
              ? t('ai.quickAction.proofread.checking')
              : t('ai.quickAction.proofread.button')}
          </button>
        )}
        {/* §3.3 B6 draft side: rendered only for an account that opted in. A
            picker plus one button, and NOTHING here is an effect — no
            translation is ever requested on window open, when the suggested
            language appears, when the user changes it, or a second time after
            one was produced. The button is inert until a target exists. */}
        {tr.active && (
          <>
            <Languages size={14} className="compose-quick-actions-icon" aria-hidden="true" />
            {/* The picker is NOT gated on the toolbar's occupancy: choosing a
                language starts nothing and spends nothing, so blocking it
                behind another action's panel would be a restriction with no
                accident to prevent. Only the button, which spends money, is. */}
            <TranslateLanguageSelect
              value={tr.targetLang}
              onChange={tr.setTargetLang}
              ariaLabel={t('ai.quickAction.translate.targetLabel')}
              testId="compose-translate-target"
              placeholder={t('ai.quickAction.translate.targetPlaceholder')}
              disabled={disabled}
            />
            <button
              type="button"
              className="compose-quick-action-btn compose-translate-btn"
              data-testid="compose-translate-run"
              disabled={
                !canRun || !tr.canRun || tr.busy
                || isBlockedByOtherAction(activity, 'translate')
              }
              aria-busy={tr.busy}
              onClick={() => tr.run(text)}
              title={t('ai.quickAction.translate.button')}
            >
              {/* Keyed on `busy` rather than on the status so the button that
                  is disabled because a call is still out also SAYS so — after
                  a mid-flight target change the status is idle while the call
                  is not, and a silently dead button is the worse half of that
                  pair. */}
              {tr.busy
                ? <Loader2 size={13} className="spin" aria-hidden="true" />
                : null}
              {tr.busy
                ? t('ai.quickAction.translate.loading')
                : t('ai.quickAction.translate.button')}
            </button>
          </>
        )}
      </div>

      {qa.status === 'refused' && qa.refusal && (
        <div className="compose-quick-actions-refusal" data-testid="compose-quick-actions-refusal">
          {t(refusalMessageKey(qa.refusal))}
        </div>
      )}

      {pr.status === 'refused' && pr.refusal && (
        <div className="compose-quick-actions-refusal" data-testid="compose-proofread-refusal">
          {t(proofreadRefusalMessageKey(pr.refusal))}
        </div>
      )}

      {tr.status === 'refused' && tr.refusal && (
        <div className="compose-quick-actions-refusal" data-testid="compose-translate-refusal">
          {t(translateRefusalMessageKey(tr.refusal))}
        </div>
      )}

      {pr.status === 'ready' && pr.review && (
        <ProofreadPanel
          review={pr.review}
          accepted={pr.accepted}
          stale={proofreadStale}
          onToggleEdit={pr.toggleEdit}
          onAcceptAll={pr.acceptAll}
          onApply={() => {
            // §2.78 AC-h: never write spans computed against a snapshot over a
            // draft the user edited meanwhile. Apply is disabled in that state;
            // this guard covers a programmatic click.
            if (proofreadStale) return
            const next = pr.buildAcceptedBody()
            // `null` means nothing was accepted — dismiss without touching the
            // body rather than writing an identical string back over it.
            if (next != null) onReplace(next)
            pr.dismiss()
          }}
          onCancel={pr.dismiss}
        />
      )}

      {qa.status === 'ready' && qa.preview && (
        <QuickActionDiff
          preview={qa.preview}
          stale={isPreviewStale(qa.preview, text)}
          onReplace={() => {
            // §2.78 AC-h: never write a snapshot-derived body over a draft the
            // user edited while the rewrite was in flight. The button is also
            // disabled in that state — this guard covers a programmatic click.
            if (isPreviewStale(qa.preview!, text)) return
            // The replacement carries the quoted original / forwarded message /
            // signature through byte-identical; only the user's own part moves.
            onReplace(qa.preview!.replacement)
            qa.dismiss()
          }}
          onInsert={() => {
            const { text: next, caret } = insertAtCaret(text, qa.preview!.rewritten, getCaret())
            onInsert(next, caret)
            qa.dismiss()
          }}
          onCancel={qa.dismiss}
        />
      )}

      {/* The SAME review panel as the four rewrites: Replace / Insert at cursor
          / Cancel, no auto-substitution, and the staleness rule applies here
          too — a translation computed over a snapshot must not be written over
          a draft edited while it was in flight (§2.78 AC-h). */}
      {tr.status === 'ready' && tr.preview && (
        <QuickActionDiff
          preview={{
            original: tr.preview.original,
            rewritten: tr.preview.rewritten,
            labelKey: 'ai.quickAction.translate.diffLabel',
          }}
          stale={isPreviewStale(tr.preview, text)}
          onReplace={() => {
            if (isPreviewStale(tr.preview!, text)) return
            // Carries the quoted original / forwarded message / signature
            // through byte-identically; only the user's own part moves.
            onReplace(tr.preview!.replacement)
            tr.dismiss()
          }}
          onInsert={() => {
            const { text: next, caret } = insertAtCaret(text, tr.preview!.rewritten, getCaret())
            onInsert(next, caret)
            tr.dismiss()
          }}
          onCancel={tr.dismiss}
        />
      )}
    </div>
  )
}
