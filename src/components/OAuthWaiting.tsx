import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OAuthConnectStage } from '@mailcopilot/types'

export interface OAuthWaitingProps {
  provider: 'gmail' | 'outlook'
  stage: OAuthConnectStage
}

/**
 * §2.94 — the account wizard step shown for the duration of an OAuth
 * connection, in place of the provider picker.
 *
 * Two problems it solves, both reported from a real account:
 *  1. The picker used to stay on screen for the whole flow, so a user coming
 *     back from the browser could not tell whether anything had happened.
 *  2. Its buttons stayed live: a second click on the same provider hit the
 *     "already running in another window" guard, and a click on the *other*
 *     provider started a second, independent flow racing the first one.
 *
 * The stage line matters more than the spinner. Once the browser hands
 * control back, main still probes IMAP (up to 30s) and SMTP (15s plus a 15s
 * STARTTLS retry) before saving — a silent minute reads as a hang, which is
 * exactly what was reported.
 */
export default function OAuthWaiting({ provider, stage }: OAuthWaitingProps) {
  const { t } = useTranslation()
  const providerName = provider === 'gmail'
    ? t('account.wizard.provider.gmail.label')
    : t('account.wizard.provider.outlook.label')

  return (
    <section className="form-section" data-testid="account-wizard-oauth-waiting">
      <h3>{t('account.wizard.oauthWaiting.title', { provider: providerName })}</h3>
      <div className="oauth-waiting">
        <Loader2 size={18} className="spin" aria-hidden="true" />
        <span data-testid="account-wizard-oauth-stage" role="status" aria-live="polite">
          {t(`account.wizard.oauthWaiting.stage.${stage}`)}
        </span>
      </div>
      <p className="hint">
        {stage === 'browser'
          ? t('account.wizard.oauthWaiting.browserHint')
          : t('account.wizard.oauthWaiting.appHint')}
      </p>
    </section>
  )
}
