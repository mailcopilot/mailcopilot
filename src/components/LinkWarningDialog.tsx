import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import type { LinkPromptState } from '../hooks/useMailLinkClick'

type Props = {
  prompt: LinkPromptState
  onApprove: () => void
  onCancel: () => void
}

/**
 * Suspicious link warning dialog.
 *
 * Renders an overlay + dialog when the phishing-check pipeline in
 * `useMailLinkClick` detects IDN hostnames, http: (unencrypted), display-text
 * host mismatch, or an unsafeBypass raw-link flag. Clicking the backdrop or
 * "Cancel" dismisses without navigating; "Open anyway" calls `onApprove`.
 *
 * Used by both the main mail viewer (App.tsx) and the standalone MailWindow —
 * single source of truth for this UI pattern.
 */
export default function LinkWarningDialog({ prompt, onApprove, onCancel }: Props) {
  const { t } = useTranslation()

  return (
    <div className="confirm-overlay" role="presentation" onClick={onCancel}>
      <div
        className="confirm-dialog link-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="link-warning-title"
        aria-describedby="link-warning-desc"
        onClick={e => e.stopPropagation()}
      >
        <p id="link-warning-title">{t('mail.links.title')}</p>
        <div className="link-prompt-url" id="link-warning-desc">{prompt.url}</div>
        {prompt.text && (
          <div className="link-prompt-text">
            <div className="link-prompt-label">{t('mail.links.textLabel')}</div>
            <div className="link-prompt-value">{prompt.text}</div>
          </div>
        )}
        <ul className="link-warnings">
          {prompt.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
        <div className="confirm-dialog-actions">
          <button onClick={onCancel}>{t('mail.links.cancel')}</button>
          <button
            className="btn-primary"
            data-testid="link-open-anyway"
            onClick={onApprove}
          >
            <ExternalLink size={14} /> {t('mail.links.openAnyway')}
          </button>
        </div>
      </div>
    </div>
  )
}
