/**
 * InstantReplyStrip — B4 Instant Reply presentation layer.
 *
 * A thin, presentational strip rendered inside the actively-open card in
 * ThreadView. It offers a single "Instant Reply" trigger; on click the hook
 * generates 2–3 draft options which render as selectable chips. Selecting a
 * draft calls `onPick(draft)` — the parent prefills a NEW Compose via the
 * existing `ui:openCompose` mechanism. NOTHING is sent automatically
 * (no-auto-send invariant). Refusals render graceful inline copy (B2 style).
 *
 * All logic lives in `useInstantReply`; this component only renders its output
 * and forwards the message ref on trigger. Every label is `t('...')`.
 */

import { useTranslation } from 'react-i18next'
import { MessageSquareReply, Loader2 } from 'lucide-react'
import type {
  InstantReplyDraft,
  InstantReplyRefusalReason,
} from '../utils/quickActions'
import type {
  InstantReplyMessageRef,
  InstantReplyStatus,
} from '../hooks/useInstantReply'

export type InstantReplyStripProps = {
  status: InstantReplyStatus
  drafts: InstantReplyDraft[]
  refusal: InstantReplyRefusalReason | null
  /** The active/last message ref to generate replies for. */
  messageRef: InstantReplyMessageRef
  /** Fire generate for `messageRef`. */
  onGenerate: (ref: InstantReplyMessageRef) => void
  /** User picked a draft option — parent prefills a new Compose. */
  onPick: (draft: InstantReplyDraft) => void
}

/** Map a surfaced refusal reason to its localized inline message key. */
function refusalMessageKey(reason: InstantReplyRefusalReason): string {
  switch (reason) {
    case 'budget':
      return 'ai.instantReply.refusal.budget'
    case 'no_provider':
      return 'ai.instantReply.refusal.noProvider'
    case 'provider_error':
      return 'ai.instantReply.refusal.providerError'
    default:
      return 'ai.instantReply.refusal.providerError'
  }
}

/** A short one-line preview of a draft for the chip body. */
function draftPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized
}

export function InstantReplyStrip({
  status,
  drafts,
  refusal,
  messageRef,
  onGenerate,
  onPick,
}: InstantReplyStripProps) {
  const { t } = useTranslation()

  return (
    <div className="instant-reply-strip" data-testid="instant-reply-strip">
      <button
        type="button"
        className="instant-reply-trigger"
        data-testid="instant-reply-trigger"
        disabled={status === 'loading'}
        aria-busy={status === 'loading'}
        onClick={() => onGenerate(messageRef)}
        title={t('ai.instantReply.trigger')}
      >
        {status === 'loading' ? (
          <Loader2 size={14} className="spin" aria-hidden="true" />
        ) : (
          <MessageSquareReply size={14} aria-hidden="true" />
        )}
        <span>{t('ai.instantReply.trigger')}</span>
      </button>

      {status === 'refused' && refusal && (
        <div className="instant-reply-refusal" data-testid="instant-reply-refusal">
          {t(refusalMessageKey(refusal))}
        </div>
      )}

      {status === 'ready' && drafts.length > 0 && (
        <div className="instant-reply-options" data-testid="instant-reply-options">
          {drafts.map((draft, i) => (
            <button
              key={i}
              type="button"
              className="instant-reply-option"
              data-testid="instant-reply-option"
              onClick={() => onPick(draft)}
              title={t('ai.instantReply.useThisDraft')}
            >
              {draft.tone && (
                <span className="instant-reply-option-tone">{draft.tone}</span>
              )}
              <span className="instant-reply-option-preview">
                {draftPreview(draft.text)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
