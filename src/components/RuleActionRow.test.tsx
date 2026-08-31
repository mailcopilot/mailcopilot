// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import RuleActionRow from './RuleActionRow'
import type { MailRuleActionDraft } from './mailRuleDrafts'

// The stub echoes the key, so assertions are about which notice appears and
// which controls exist, never about copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

afterEach(cleanup)

function renderRow(action: MailRuleActionDraft, onChange = vi.fn()) {
  render(<RuleActionRow action={action} onChange={onChange} onRemove={vi.fn()} />)
  return onChange
}

describe('RuleActionRow', () => {
  it('shows the folder field only for a move', () => {
    renderRow({ type: 'move', folder: 'Later' })
    expect(screen.getByRole('textbox')).toHaveValue('Later')
    cleanup()
    renderRow({ type: 'archive' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  // The point of the row: the refusal is stated at the field, before the save,
  // instead of arriving afterwards as "the rule is not in an applicable form".
  it('warns when a move names no folder', () => {
    renderRow({ type: 'move' })
    expect(screen.getByTestId('rule-move-folder-required')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
  })

  it('warns for a folder made of whitespace', () => {
    renderRow({ type: 'move', folder: '   ' })
    expect(screen.getByTestId('rule-move-folder-required')).toBeInTheDocument()
  })

  it('stops warning once a folder is named', () => {
    renderRow({ type: 'move', folder: 'Later' })
    expect(screen.queryByTestId('rule-move-folder-required')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid')
  })

  it('never warns about an action that carries no folder', () => {
    renderRow({ type: 'archive' })
    expect(screen.queryByTestId('rule-move-folder-required')).not.toBeInTheDocument()
  })

  it('reports the folder verbatim, without trimming the value', () => {
    // Trimming here would rename the user's mailbox: a space is legal in an
    // IMAP name, and only the "is it empty" decision may trim.
    const onChange = renderRow({ type: 'move', folder: '' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Archive 2026 ' } })
    expect(onChange).toHaveBeenCalledWith({ type: 'move', folder: ' Archive 2026 ' })
  })

  it('drops the folder when the action type changes', () => {
    const onChange = renderRow({ type: 'move', folder: 'Later' })
    fireEvent.click(screen.getAllByRole('combobox')[0]!)
    fireEvent.click(screen.getByText('settings.rules.action.archive'))
    expect(onChange).toHaveBeenCalledWith({ type: 'archive' })
  })
})
