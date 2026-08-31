import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Info } from 'lucide-react'
import type {
  AiDestinationField,
  AiDestinationRejection,
} from '../../hooks/useAiDestinationRejection'

/**
 * "The address AI requests are sent to was not changed" (BACKLOG §2.119).
 *
 * Shown in the settings window after a `settings:save` whose destination
 * change main refused. The window stays open in that case, and this notice is
 * the reason it stayed — see src/hooks/useAiDestinationRejection.ts.
 *
 * STYLING REUSES THE TWO BANNERS THE APP ALREADY HAS rather than inventing a
 * settings-specific one: `.error-banner` (the error surface used by App.tsx
 * and MailWindow.tsx) and `.privacy-banner` (the warn-toned informational
 * surface used for blocked remote images). Which one is picked is the whole
 * per-reason differentiation of tone:
 *
 *  - `declined` — the person pressed Cancel themselves. Nothing failed and
 *    nothing is wrong, so it must not look like an error; it is stated calmly
 *    because the only harm here is a false belief about where the key goes.
 *  - `busy` — transient. Same calm surface, plus the one thing that is
 *    actionable: try again.
 *  - `invalid` — the value cannot be used and the person has to correct it.
 *    That is the only branch where an alert is warranted.
 *
 * THE SENTENCE ITSELF COMES FROM MAIN, verbatim. Main localized it from the
 * same locale files this component reads, so it matches the native dialog the
 * person just answered. What this component adds around it is renderer-only
 * context main cannot know it needs: which field is affected (both inputs are
 * on screen at once, so "the address" alone is a puzzle) and the fact that the
 * rest of the save did land.
 */

const FIELD_LABEL_KEYS: Record<AiDestinationField, string> = {
  // The dialog's own labels, on purpose: the person is reading the name of the
  // same thing they were just asked about.
  aiOpenAiBaseUrl: 'aiDestination.endpointLabel',
  aiProxyUrl: 'aiDestination.proxyLabel',
}

const HEADING_KEYS = {
  declined: 'settings.aiDestination.declinedTitle',
  invalid: 'settings.aiDestination.invalidTitle',
  busy: 'settings.aiDestination.busyTitle',
} as const

export interface AiDestinationRejectionNoticeProps {
  /** Nothing is rendered when null. */
  rejection: AiDestinationRejection | null
  /** Re-run the save. Offered for the transient `busy` case only. */
  onRetry: () => void
}

export default function AiDestinationRejectionNotice({
  rejection,
  onRetry,
}: AiDestinationRejectionNoticeProps) {
  const { t } = useTranslation()
  if (!rejection) return null

  const isError = rejection.reason === 'invalid'
  const fieldNames = rejection.fields.map(field => t(FIELD_LABEL_KEYS[field])).join(', ')

  return (
    <div
      className={isError ? 'error-banner' : 'privacy-banner'}
      role={isError ? 'alert' : 'status'}
      data-testid="settings-ai-destination-notice"
      data-reason={rejection.reason}
      style={{ alignItems: 'flex-start', marginTop: 16 }}
    >
      {rejection.reason === 'invalid'
        ? <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        : rejection.reason === 'busy'
          ? <Clock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          : <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />}
      <div>
        <div data-testid="settings-ai-destination-title">
          <strong>{t(HEADING_KEYS[rejection.reason])}</strong>
        </div>
        {rejection.message !== '' && (
          <div data-testid="settings-ai-destination-message">{rejection.message}</div>
        )}
        {fieldNames !== '' && (
          <div data-testid="settings-ai-destination-fields">
            {t('settings.aiDestination.unchangedFields', { fields: fieldNames })}
          </div>
        )}
        <div data-testid="settings-ai-destination-other-saved">
          {t('settings.aiDestination.otherSettingsSaved')}
        </div>
        {rejection.reason === 'busy' && (
          <button
            type="button"
            data-testid="settings-ai-destination-retry"
            style={{ marginTop: 6 }}
            onClick={onRetry}
          >
            {t('settings.aiDestination.retry')}
          </button>
        )}
      </div>
    </div>
  )
}
