import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useSentCopyFailureToast } from '../hooks/useSentCopyFailureToast'

/**
 * Non-modal toast shown when an outgoing message was delivered via SMTP but
 * the IMAP APPEND of its copy into the Sent folder failed (BACKLOG §2.23 PR1,
 * `mail:sentCopyFailed` broadcast). Reuses the `.undo-bar` styling — the
 * existing bottom-center toast pattern (undo bar / update bar).
 *
 * Deliberately no Retry button: the append retry queue is §2.23 PR2.
 * The toast never shows message content or recipients — only the Sent
 * folder path when known.
 */
export default function SentCopyFailedToast() {
  const { t } = useTranslation()
  const { sentCopyFailure, dismissSentCopyFailure } = useSentCopyFailureToast()

  if (!sentCopyFailure) return null

  return (
    <div className="undo-bar" role="status" data-testid="sent-copy-failed-toast">
      <AlertTriangle size={14} />
      <span>
        {sentCopyFailure.folder
          ? t('app.sentCopyFailed.messageWithFolder', { folder: sentCopyFailure.folder })
          : t('app.sentCopyFailed.message')}
      </span>
      <button
        type="button"
        data-testid="sent-copy-failed-dismiss"
        onClick={dismissSentCopyFailure}
      >
        {t('app.sentCopyFailed.dismiss')}
      </button>
    </div>
  )
}
