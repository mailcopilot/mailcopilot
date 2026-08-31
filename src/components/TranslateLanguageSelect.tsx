/**
 * TranslateLanguageSelect — §3.3 B6, the ONE language picker.
 *
 * A `<select>` over the closed sixteen-code set, shared by the reading-pane bar
 * (`MailTranslateBar`) and the compose-window control (`ComposeQuickActions`).
 * It started as a private function inside `MailTranslateBar.tsx` and was lifted
 * here when the draft side needed the same control: two copies of a widget whose
 * whole job is "no free-form string can reach the request" is two places for
 * that property to be weakened independently.
 *
 * The option labels are localized (`mail.translate.languages.<code>`); the
 * VALUES are the contract codes and nothing else.
 */

import { useTranslation } from 'react-i18next'
import type { TranslateLanguageCode } from '@mailcopilot/types'
// By path, not through the `@mailcopilot/core` barrel — see the note in
// `useMailTranslation.ts`. Only the code list is used; no detection runs here.
import { TRANSLATE_LANGUAGE_CODES, isTranslateLanguageCode } from '../../packages/core/language'

export type TranslateLanguageSelectProps = {
  value: TranslateLanguageCode | null
  onChange: (code: TranslateLanguageCode) => void
  ariaLabel: string
  testId: string
  placeholder?: string
  disabled?: boolean
}

export default function TranslateLanguageSelect({
  value,
  onChange,
  ariaLabel,
  testId,
  placeholder,
  disabled,
}: TranslateLanguageSelectProps) {
  const { t } = useTranslation()
  return (
    <select
      className="mail-translate-select"
      data-testid={testId}
      aria-label={ariaLabel}
      value={value ?? ''}
      disabled={disabled}
      onChange={e => {
        const next = e.target.value
        // The guard is not ceremony: `select.value` is a string as far as the
        // type system is concerned, and only a member of the closed set may
        // ever reach the request.
        if (isTranslateLanguageCode(next)) onChange(next)
      }}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {TRANSLATE_LANGUAGE_CODES.map(code => (
        <option key={code} value={code}>
          {t(`mail.translate.languages.${code}`)}
        </option>
      ))}
    </select>
  )
}
