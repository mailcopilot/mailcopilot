// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import RuleConditionRow from './RuleConditionRow'
import {
  DEFAULT_RULE_CONDITION_FIELD,
  isSenderControlledField,
  isValuelessField,
  ruleConditionFieldChoices,
  ruleConditionNotice,
} from './ruleFields'

// The stub echoes `defaultValue` when the caller supplies one (field labels do)
// and the key otherwise. Assertions are therefore about which options exist and
// when the caveat shows, never about copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

afterEach(cleanup)

function renderRow(field: string, onChange = vi.fn(), actions: unknown = []) {
  render(
    <RuleConditionRow
      condition={{ field, op: 'contains', value: 'user@example.com' }}
      actions={actions}
      onChange={onChange}
      onRemove={vi.fn()}
    />,
  )
  return onChange
}

/** Values of the field dropdown, in order, after opening it. */
function openFieldOptions(): string[] {
  const trigger = screen.getAllByRole('combobox')[0]!
  fireEvent.click(trigger)
  return screen.getAllByRole('option').map(o => o.textContent ?? '')
}

describe('ruleConditionFieldChoices', () => {
  it('offers the split sender fields and not the deprecated one', () => {
    const choices = ruleConditionFieldChoices(DEFAULT_RULE_CONDITION_FIELD)
    expect(choices).toContain('from_address')
    expect(choices).toContain('from_name')
    expect(choices).not.toContain('from')
  })

  it('keeps the deprecated `from` visible while a condition still uses it', () => {
    // Rules configured before the split must stay readable and editable.
    expect(ruleConditionFieldChoices('from')).toContain('from')
  })

  it('drops `from` again once the condition moved off it', () => {
    expect(ruleConditionFieldChoices('from_address')).not.toContain('from')
  })

  it('preserves an unknown field so opening a rule never rewrites it', () => {
    const choices = ruleConditionFieldChoices('reply_to_address')
    expect(choices).toContain('reply_to_address')
    expect(choices[choices.length - 1]).toBe('reply_to_address')
  })

  it('does not append an empty field value', () => {
    expect(ruleConditionFieldChoices('')).not.toContain('')
  })

  it('no longer offers the field the client cannot answer about', () => {
    // §2.91: nothing stores CC, so a condition on it matched every message.
    expect(ruleConditionFieldChoices(DEFAULT_RULE_CONDITION_FIELD)).not.toContain('cc')
  })

  it('keeps a saved `cc` condition visible instead of rewriting it', () => {
    expect(ruleConditionFieldChoices('cc')).toContain('cc')
  })

  it('classifies sender-controlled and valueless fields', () => {
    expect(isSenderControlledField('from_name')).toBe(true)
    expect(isSenderControlledField('from')).toBe(true)
    expect(isSenderControlledField('from_address')).toBe(false)
    expect(isSenderControlledField('subject')).toBe(false)
    expect(isValuelessField('has_attachment')).toBe(true)
    expect(isValuelessField('from_address')).toBe(false)
  })
})

describe('ruleConditionNotice', () => {
  it('reports an unsupported field whatever the rule does', () => {
    expect(ruleConditionNotice('cc', [])).toEqual({ kind: 'unsupported_field' })
    expect(ruleConditionNotice('cc', [{ type: 'mark_read' }])).toEqual({
      kind: 'unsupported_field',
    })
  })

  it('reports a field written by another build as unsupported too', () => {
    expect(ruleConditionNotice('reply_to_address', [])).toEqual({ kind: 'unsupported_field' })
  })

  it('names the destructive action that refuses the legacy sender field', () => {
    expect(ruleConditionNotice('from', [{ type: 'mark_read' }, { type: 'trash' }])).toEqual({
      kind: 'unverifiable_sender',
      action: 'trash',
    })
  })

  it('keeps the legacy field at advice level while no action destroys mail', () => {
    // Marking is reversible, so an existing rule is not broken over a forgeable
    // display name — the user is only told what the match is worth.
    expect(ruleConditionNotice('from', [{ type: 'mark_read' }])).toEqual({
      kind: 'sender_controlled',
    })
  })

  it('refuses a display-name match once the rule deletes mail', () => {
    // Advice was the earlier behaviour. The AI tool contract had always claimed
    // a destructive action could not be gated on the display name; §2.162's
    // review found nothing enforced it, and the enforcement now covers
    // `from_name` as well as the legacy field. The editor follows the engine
    // automatically — it asks `findMailRuleRefusal` rather than keeping a list.
    expect(ruleConditionNotice('from_name', [{ type: 'trash' }])).toEqual({
      kind: 'unverifiable_sender',
      action: 'trash',
    })
  })

  it('keeps the display-name field at advice level while nothing destroys mail', () => {
    expect(ruleConditionNotice('from_name', [{ type: 'mark_read' }])).toEqual({
      kind: 'sender_controlled',
    })
  })

  it('says nothing about a field that can be checked', () => {
    expect(ruleConditionNotice('from_address', [{ type: 'trash' }])).toBeNull()
    expect(ruleConditionNotice('subject', [{ type: 'move', folder: 'X' }])).toBeNull()
  })

  it('says nothing about a half-built row', () => {
    expect(ruleConditionNotice('', [{ type: 'trash' }])).toBeNull()
  })

  it('judges the field alone when the actions are not a list', () => {
    // Core answers `malformed_rule` for that input — a verdict about the whole
    // rule, which must not surface as a warning under one condition row. The
    // row still says what it can about the field itself.
    expect(ruleConditionNotice('cc', undefined)).toEqual({ kind: 'unsupported_field' })
    expect(ruleConditionNotice('from_name', 'not-a-list')).toEqual({ kind: 'sender_controlled' })
    expect(ruleConditionNotice('from_address', null)).toBeNull()
  })
})

describe('RuleConditionRow', () => {
  it('lists the split sender fields for a new condition, without the legacy one', () => {
    renderRow(DEFAULT_RULE_CONDITION_FIELD)
    const options = openFieldOptions()
    // The i18n mock echoes the field id (fieldLabel passes it as defaultValue).
    expect(options).toContain('from_address')
    expect(options).toContain('from_name')
    expect(options).not.toContain('from')
  })

  it('lists the legacy field when the condition is still on it', () => {
    renderRow('from')
    expect(openFieldOptions()).toContain('from')
  })

  it('warns that a display-name match is forgeable', () => {
    renderRow('from_name')
    expect(screen.getByTestId('rule-display-name-caveat'))
      .toHaveTextContent('settings.rules.displayNameCaveat')
  })

  it('warns for the legacy field too — it also matches the display name', () => {
    renderRow('from')
    expect(screen.getByTestId('rule-display-name-caveat')).toBeInTheDocument()
  })

  it('shows no caveat when matching on the address', () => {
    renderRow('from_address')
    expect(screen.queryByTestId('rule-display-name-caveat')).not.toBeInTheDocument()
  })

  it('shows a saved `cc` condition and explains that it no longer fires', () => {
    renderRow('cc')
    expect(openFieldOptions()).toContain('cc')
    expect(screen.getByTestId('rule-unsupported-field-caveat'))
      .toHaveTextContent('settings.rules.unsupportedFieldCaveat')
  })

  it('explains the refusal when the legacy sender field drives a destructive action', () => {
    renderRow('from', vi.fn(), [{ type: 'trash' }])
    expect(screen.getByTestId('rule-unverifiable-sender-caveat'))
      .toHaveTextContent('settings.rules.unverifiableSenderCaveat')
    // The milder caveat is replaced, not stacked on top of the refusal.
    expect(screen.queryByTestId('rule-display-name-caveat')).not.toBeInTheDocument()
  })

  it('shows no refusal for a supported field', () => {
    renderRow('from_address', vi.fn(), [{ type: 'trash' }])
    expect(screen.queryByTestId('rule-unsupported-field-caveat')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rule-unverifiable-sender-caveat')).not.toBeInTheDocument()
  })

  it('hides operator and value for a boolean field', () => {
    renderRow('has_attachment')
    // Only the field dropdown remains — no operator dropdown, no value input.
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('reports a field change to the parent without touching op or value', () => {
    const onChange = renderRow('from_address')
    fireEvent.click(screen.getAllByRole('combobox')[0]!)
    fireEvent.click(screen.getByText('from_name'))
    expect(onChange).toHaveBeenCalledWith({
      field: 'from_name',
      op: 'contains',
      value: 'user@example.com',
    })
  })
})
