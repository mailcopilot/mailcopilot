import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import Select from './Select'
import {
  isValuelessField,
  ruleConditionFieldChoices,
  ruleConditionNotice,
} from './ruleFields'
import { ruleActionLabel, ruleFieldLabel } from './ruleRefusalText'

export interface RuleConditionDraft {
  field: string
  op: string
  value: string
}

export interface RuleConditionRowProps {
  condition: RuleConditionDraft
  /**
   * Actions of the rule being edited. Needed because a condition is not judged
   * on its own: a match on the sender's display name (`from_name`, or the
   * legacy `from`) is fine for marking mail and refused for moving or deleting
   * it, so the warning depends on what the rule does. Defaults to none, i.e.
   * the mildest verdict.
   */
  actions?: unknown
  onChange: (next: RuleConditionDraft) => void
  onRemove: () => void
}

const CONDITION_OPS = [
  'contains',
  'not_contains',
  'equals',
  'starts_with',
  'ends_with',
  'matches_regex',
] as const

/**
 * One condition row of the mail-rules editor: field / operator / value plus the
 * remove button, and a one-line notice under it whenever the condition is
 * weak (a sender-chosen display name behind a reversible action) or outright
 * refused (a field the client never stores, or a display-name match driving a
 * destructive action).
 *
 * The notice always explains *why*, never just "not allowed": a user whose
 * saved rule stopped firing has to be able to tell what changed and what to
 * pick instead. Which combinations are refused is decided in
 * `@mailcopilot/core` via ./ruleFields, never re-listed here.
 *
 * Extracted out of Settings.tsx (CLAUDE.md §5 hotspot policy): the field list
 * now has real rules behind it (deprecated `from`, unsupported `cc`, unknown
 * values preserved — see ./ruleFields) and those do not belong in a 3800-line
 * screen component.
 */
export default function RuleConditionRow({
  condition,
  actions,
  onChange,
  onRemove,
}: RuleConditionRowProps) {
  const { t } = useTranslation()
  const fieldLabel = (f: string): string => ruleFieldLabel(t, f)
  const notice = ruleConditionNotice(condition.field, actions ?? [])

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Select
          value={condition.field}
          onChange={v => onChange({ ...condition, field: v })}
          ariaLabel={t('settings.rules.conditionField')}
          options={ruleConditionFieldChoices(condition.field).map(f => ({
            value: f,
            label: fieldLabel(f),
          }))}
        />
        {!isValuelessField(condition.field) && (
          <>
            <Select
              value={condition.op}
              onChange={v => onChange({ ...condition, op: v })}
              ariaLabel={t('settings.rules.conditionOp')}
              options={CONDITION_OPS.map(o => ({ value: o, label: t(`settings.rules.op.${o}`) }))}
            />
            <input
              type="text"
              value={condition.value}
              onChange={e => onChange({ ...condition, value: e.target.value })}
              style={{ flex: 1 }}
            />
          </>
        )}
        <button className="btn-icon" onClick={onRemove} aria-label={t('settings.rules.removeCondition')}>
          <X size={14} />
        </button>
      </div>
      {notice?.kind === 'unsupported_field' && (
        <p
          className="hint"
          role="alert"
          data-testid="rule-unsupported-field-caveat"
          style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--danger, #ef4444)' }}
        >
          {t('settings.rules.unsupportedFieldCaveat', { field: fieldLabel(condition.field) })}
        </p>
      )}
      {notice?.kind === 'unverifiable_sender' && (
        <p
          className="hint"
          role="alert"
          data-testid="rule-unverifiable-sender-caveat"
          style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--danger, #ef4444)' }}
        >
          {t('settings.rules.unverifiableSenderCaveat', {
            action: ruleActionLabel(t, notice.action),
            suggestion: fieldLabel('from_address'),
          })}
        </p>
      )}
      {notice?.kind === 'sender_controlled' && (
        <p
          className="hint"
          data-testid="rule-display-name-caveat"
          style={{ margin: '2px 0 0', fontSize: 12 }}
        >
          {t('settings.rules.displayNameCaveat')}
        </p>
      )}
    </div>
  )
}
