import type { Identity } from '@mailcopilot/types'
import { formatIdentityOption } from '../utils/identity'

export type IdentityPickerProps = {
  identities: readonly Identity[]
  selectedId: string | null
  onChange: (id: string) => void
  /** Label for accessibility; passed in so callers control i18n. */
  label?: string
  /** data-testid to ease test targeting (default: 'identity-picker'). */
  testId?: string
  /** Disable the picker (e.g. while sending). */
  disabled?: boolean
}

/**
 * Dropdown for selecting which identity the user sends from. Keyboard-accessible
 * via the native `<select>` semantics; label associates for screen readers.
 *
 * Intentionally thin — selection logic lives in `useIdentitySelection`.
 */
export default function IdentityPicker(props: IdentityPickerProps) {
  const { identities, selectedId, onChange, label, testId = 'identity-picker', disabled } = props

  // Single-identity accounts still render — the caller decides whether to
  // hide the control entirely. This keeps the component contract simple and
  // lets tests assert against the rendered output in both shapes.
  return (
    <label className="identity-picker">
      {label && <span className="identity-picker-label">{label}</span>}
      <select
        data-testid={testId}
        className="identity-picker-select"
        value={selectedId ?? ''}
        disabled={disabled || identities.length === 0}
        onChange={e => {
          const next = e.target.value
          if (next) onChange(next)
        }}
      >
        {identities.map(ident => (
          <option key={ident.id} value={ident.id}>
            {formatIdentityOption(ident)}
          </option>
        ))}
      </select>
    </label>
  )
}
