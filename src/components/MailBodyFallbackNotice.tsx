/**
 * MailBodyFallbackNotice — the placeholder shown in place of a message body
 * that could not be produced, in every window that reads mail.
 *
 * §2.17 Phase 1 fix wave. Before this file the same block was written twice —
 * once in MailBodyContent (the main window's reading pane) and once in
 * MailWindow (the standalone message window) — and the copies had already
 * drifted: the standalone one rendered the sentence but not the Retry button,
 * so a failed load there was a dead end with no way out but closing the
 * window. Extracting is the fix rather than a tidy-up: the defect WAS the
 * duplication, and the branch was about to grow a third arm, which would have
 * doubled the chance of the next drift.
 *
 * The component owns no state and makes no IPC call. Which reason the envelope
 * carries is decided in electron/main.ts (see `buildOfflineFallback`); the
 * words, icon and test id come from `src/utils/mailBodyFallback.ts`. All this
 * file does is render them and ask its caller for the retry action.
 */

import { useTranslation } from 'react-i18next'
import {
  presentationForReason,
  type MailBodyFallbackReason,
} from '../utils/mailBodyFallback'

type MailBodyFallbackNoticeProps = {
  reason: MailBodyFallbackReason
  /** Omitted only when there is genuinely nothing to retry (the main window
   *  passes it only while a message is active). When omitted the button is not
   *  rendered — it must never be rendered as a no-op. */
  onRetry?: () => void
}

export default function MailBodyFallbackNotice({ reason, onRetry }: MailBodyFallbackNoticeProps) {
  const { t } = useTranslation()
  const { testId, icon: Icon, messageKey } = presentationForReason(reason)
  return (
    <div className="empty-state offline-fallback" data-testid={testId}>
      <Icon size={24} />
      <p>{t(messageKey)}</p>
      {onRetry && (
        <button
          type="button"
          className="btn-primary"
          data-testid="mail-offline-retry"
          onClick={onRetry}
        >
          {t('mail.actions.retry')}
        </button>
      )}
    </div>
  )
}
