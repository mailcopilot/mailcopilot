/**
 * SingleMessageInstantReply — §3.3 B4 Instant Reply for the single-message
 * reading-pane path.
 *
 * ThreadView embeds an `InstantReplyStrip` on the actively-open card of a
 * multi-message thread. Single messages (thread.count === 1, or grouping off)
 * render their body directly through `MailBodyContent` and would otherwise get
 * no Instant Reply affordance — even though the feature is documented as
 * available on any open email. This component gives that path parity by owning
 * its own `useInstantReply()` state machine and rendering the SAME
 * `InstantReplyStrip` above the body.
 *
 * Behavior mirrors the thread path exactly:
 * - Only rendered when the per-account opt-in is ON and a provider is configured
 *   (the parent gates rendering on `isAiFeatureEnabledForAccount(...)`).
 * - `messageRef` is derived from the active single message `(accountId, folder,
 *   uid)`.
 * - Picking a draft calls `onPick(ref, draft)` — the parent prefills a NEW
 *   Compose via `ui:openCompose`. NOTHING is sent automatically (no-auto-send
 *   invariant); the user still presses Send.
 * - State resets whenever the active message changes (keyed on the ref) so draft
 *   options generated for one message never leak onto another.
 *
 * All request/refusal/options logic lives in `useInstantReply`; this component
 * only wires the active message ref into the strip (CLAUDE.md §5 hotspot policy).
 */

import { useEffect } from 'react'
import { useInstantReply } from '../hooks/useInstantReply'
import type { InstantReplyDraft } from '../utils/quickActions'
import { InstantReplyStrip } from './InstantReplyStrip'

export type SingleMessageInstantReplyProps = {
  /** The active single message the reply is scoped to. */
  message: {
    accountId: number
    folder: string
    uid: number
    messageId?: string | null
  }
  /**
   * User picked a draft option. The parent prefills a NEW Compose (via
   * `ui:openCompose`) with the draft body; nothing is sent automatically.
   */
  onPick: (
    ref: { accountId: number; folder: string; uid: number },
    draft: InstantReplyDraft,
  ) => void
}

export function SingleMessageInstantReply({
  message,
  onPick,
}: SingleMessageInstantReplyProps) {
  const instantReply = useInstantReply()

  // Reset Instant Reply state when the active message changes so options
  // generated for one message never leak onto another (dismiss is idempotent
  // when already idle). Keyed on the active message's identity.
  const dismiss = instantReply.dismiss
  const messageKey = `${message.accountId}:${message.folder}:${message.uid}`
  useEffect(() => {
    dismiss()
  }, [messageKey, dismiss])

  return (
    <InstantReplyStrip
      status={instantReply.status}
      drafts={instantReply.drafts}
      refusal={instantReply.refusal}
      messageRef={{
        accountId: message.accountId,
        folder: message.folder,
        uid: message.uid,
        messageId: message.messageId ?? null,
      }}
      onGenerate={instantReply.generate}
      onPick={draft => {
        onPick(
          {
            accountId: message.accountId,
            folder: message.folder,
            uid: message.uid,
          },
          draft,
        )
        instantReply.dismiss()
      }}
    />
  )
}
