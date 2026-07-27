// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Identity } from '@mailcopilot/types'
import IdentitiesTab, { type IdentitiesTabLabels, type IdentityDraft } from './IdentitiesTab'

afterEach(cleanup)

const labels: IdentitiesTabLabels = {
  tabLabel: 'Identities',
  empty: 'No identities yet',
  add: 'Add identity',
  edit: 'Edit',
  delete: 'Delete',
  setDefault: 'Set as default',
  defaultBadge: 'Default',
  displayNameLabel: 'Display name',
  emailLabel: 'Email',
  signatureLabel: 'Signature',
  defaultBccLabel: 'Default Bcc',
  cancel: 'Cancel',
  save: 'Save',
}

function makeIdentity(partial: Partial<Identity> & { id: string; email: string }): Identity {
  return {
    id: partial.id,
    email: partial.email,
    displayName: partial.displayName ?? partial.email,
    signature: partial.signature,
    defaultBcc: partial.defaultBcc,
    isDefault: partial.isDefault ?? false,
  }
}

describe('IdentitiesTab', () => {
  const identities: Identity[] = [
    makeIdentity({ id: 'work', email: 'me@work.com', displayName: 'Work', isDefault: true }),
    makeIdentity({ id: 'personal', email: 'me@home.com', displayName: 'Personal' }),
  ]

  it('renders every identity row with default badge on the default one', () => {
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} />)
    expect(screen.getByTestId('identities-row-0')).toBeTruthy()
    expect(screen.getByTestId('identities-row-1')).toBeTruthy()
    expect(screen.getByTestId('identities-default-badge-0')).toBeTruthy()
    // second row must NOT have the default badge
    expect(screen.queryByTestId('identities-default-badge-1')).toBeNull()
  })

  it('shows empty state when no identities', () => {
    render(<IdentitiesTab identities={[]} onChange={() => undefined} labels={labels} />)
    expect(screen.getByText('No identities yet')).toBeTruthy()
  })

  it('delete button is disabled on the default identity', () => {
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} />)
    const defaultDelete = screen.getByTestId('identities-delete-0') as HTMLButtonElement
    expect(defaultDelete.disabled).toBe(true)
  })

  it('clicking delete on a non-default identity emits the shorter list', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-delete-1'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('work')
  })

  it('set-as-default rotates the default flag', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-set-default-1'))
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(2)
    expect(next.find(i => i.id === 'work')?.isDefault).toBe(false)
    expect(next.find(i => i.id === 'personal')?.isDefault).toBe(true)
  })

  it('opens the editor when Add is clicked', () => {
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    expect(screen.getByTestId('identities-editor')).toBeTruthy()
    expect(screen.getByTestId('identities-editor-displayName')).toBeTruthy()
  })

  it('adding a new identity appends with given fields', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: 'New Alias' } })
    fireEvent.change(screen.getByTestId('identities-editor-email'), { target: { value: 'alias@x.com' } })
    fireEvent.click(screen.getByTestId('identities-editor-save'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(3)
    const added = next[next.length - 1]
    expect(added.displayName).toBe('New Alias')
    expect(added.email).toBe('alias@x.com')
    expect(added.isDefault).toBe(false)
  })

  it('editing an existing identity emits updated fields in place', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-edit-1'))
    fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: 'Home' } })
    fireEvent.click(screen.getByTestId('identities-editor-save'))
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(2)
    expect(next[1].displayName).toBe('Home')
    expect(next[1].id).toBe('personal')
  })

  it('when editor marks a new identity as default, previous default is demoted', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-edit-1'))
    fireEvent.click(screen.getByTestId('identities-editor-isDefault'))
    fireEvent.click(screen.getByTestId('identities-editor-save'))
    const next = onChange.mock.calls[0][0]
    const defaults = next.filter(i => i.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0].id).toBe('personal')
  })

  it('save is disabled while required fields are empty', () => {
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    const saveBtn = screen.getByTestId('identities-editor-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: 'Foo' } })
    expect((screen.getByTestId('identities-editor-save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('identities-editor-email'), { target: { value: 'a@b.c' } })
    expect((screen.getByTestId('identities-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancel closes the editor without emitting a change', () => {
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    fireEvent.click(screen.getByTestId('identities-editor-cancel'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('identities-editor')).toBeNull()
  })

  it('disabled prop suppresses edit/delete/add/set-default buttons', () => {
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} disabled />)
    expect((screen.getByTestId('identities-add') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('identities-edit-0') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('identities-edit-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('identities-delete-1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('identities-set-default-1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('single-identity list disables delete even for a non-default row (guards server invariant)', () => {
    const solo: Identity[] = [makeIdentity({ id: 'only', email: 'only@x.com', displayName: 'Only', isDefault: true })]
    render(<IdentitiesTab identities={solo} onChange={() => undefined} labels={labels} />)
    expect((screen.getByTestId('identities-delete-0') as HTMLButtonElement).disabled).toBe(true)
  })

  it('promoting an already-default identity does not emit a change', () => {
    // There is no `identities-set-default-0` button (the default row doesn't
    // render the promote control); this asserts the render contract. If the
    // component ever starts rendering the button unconditionally, this test
    // flips the contract into a behaviour expectation instead.
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
    expect(screen.queryByTestId('identities-set-default-0')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('isDefault checkbox is disabled when editing the sole default of a single-identity account', () => {
    // Ensures the UI can't produce a save payload with zero defaults, which
    // the server-side refine on identitiesArraySchema would reject anyway
    // but at the cost of a confusing error message for the user.
    const solo: Identity[] = [makeIdentity({ id: 'only', email: 'only@x.com', displayName: 'Only', isDefault: true })]
    render(<IdentitiesTab identities={solo} onChange={() => undefined} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-edit-0'))
    const isDefaultToggle = screen.getByTestId('identities-editor-isDefault') as HTMLInputElement
    expect(isDefaultToggle.disabled).toBe(true)
    expect(isDefaultToggle.checked).toBe(true)
  })

  it('adding an identity to an empty list auto-promotes it to default', () => {
    // Seeding a fresh account: the UI must not require the user to click
    // "set as default" manually. Also verifies the `makeBlankDraft(!hasAny)`
    // branch where `defaultBeingFirst` is true.
    const onChange = vi.fn<(next: IdentityDraft[]) => void>()
    render(<IdentitiesTab identities={[]} onChange={onChange} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: 'First' } })
    fireEvent.change(screen.getByTestId('identities-editor-email'), { target: { value: 'first@x.com' } })
    fireEvent.click(screen.getByTestId('identities-editor-save'))
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(1)
    expect(next[0].isDefault).toBe(true)
  })

  it('whitespace-only displayName/email keep save disabled', () => {
    // The save button uses trim() guard — ensures "  " inputs don't slip
    // through to accountSaveSchema, which would reject them and surface as
    // a generic save error in Settings.
    render(<IdentitiesTab identities={identities} onChange={() => undefined} labels={labels} />)
    fireEvent.click(screen.getByTestId('identities-add'))
    fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: '   ' } })
    fireEvent.change(screen.getByTestId('identities-editor-email'), { target: { value: '   ' } })
    expect((screen.getByTestId('identities-editor-save') as HTMLButtonElement).disabled).toBe(true)
  })

  describe('signature clear flow (2.3 wave 3)', () => {
    it('clearing the signature field on an existing identity emits explicit empty string', () => {
      // Regression: legacy code normalized empty string to undefined, which
      // saveAccount treats as "keep existing". That silently dropped the
      // user's clear intent — the old signature stayed in the legacy mirror
      // and reappeared in Compose. Wave-3 fix: preserve '' verbatim so the
      // save-path can distinguish clear from no-op.
      const withSig: Identity[] = [
        makeIdentity({ id: 'work', email: 'me@work.com', signature: 'Best,\nMe', isDefault: true }),
      ]
      const onChange = vi.fn<(next: IdentityDraft[]) => void>()
      render(<IdentitiesTab identities={withSig} onChange={onChange} labels={labels} />)
      fireEvent.click(screen.getByTestId('identities-edit-0'))
      fireEvent.change(screen.getByTestId('identities-editor-signature'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('identities-editor-save'))
      const next = onChange.mock.calls[0][0]
      expect(next).toHaveLength(1)
      // CRITICAL: '' (explicit clear), NOT undefined.
      expect(next[0].signature).toBe('')
      expect(next[0].signature).not.toBeUndefined()
    })

    it('adding a new identity without touching signature emits undefined (no signature)', () => {
      // Opposite of the clear case: if the user never types into the field,
      // the draft's signature stays undefined (via makeBlankDraft). That
      // must remain distinct from '' so saveAccount doesn't misread it.
      const onChange = vi.fn<(next: IdentityDraft[]) => void>()
      render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
      fireEvent.click(screen.getByTestId('identities-add'))
      fireEvent.change(screen.getByTestId('identities-editor-displayName'), { target: { value: 'Alias' } })
      fireEvent.change(screen.getByTestId('identities-editor-email'), { target: { value: 'alias@x.com' } })
      fireEvent.click(screen.getByTestId('identities-editor-save'))
      const next = onChange.mock.calls[0][0]
      const added = next[next.length - 1]
      expect(added.signature).toBeUndefined()
    })

    it('clearing defaultBcc field emits explicit empty string (same contract as signature)', () => {
      const withBcc: Identity[] = [
        makeIdentity({ id: 'work', email: 'me@work.com', defaultBcc: 'archive@work.com', isDefault: true }),
      ]
      const onChange = vi.fn<(next: IdentityDraft[]) => void>()
      render(<IdentitiesTab identities={withBcc} onChange={onChange} labels={labels} />)
      fireEvent.click(screen.getByTestId('identities-edit-0'))
      fireEvent.change(screen.getByTestId('identities-editor-defaultBcc'), { target: { value: '' } })
      fireEvent.click(screen.getByTestId('identities-editor-save'))
      const next = onChange.mock.calls[0][0]
      expect(next[0].defaultBcc).toBe('')
    })

    it('typing a non-empty signature emits the exact string', () => {
      const onChange = vi.fn<(next: IdentityDraft[]) => void>()
      render(<IdentitiesTab identities={identities} onChange={onChange} labels={labels} />)
      fireEvent.click(screen.getByTestId('identities-edit-0'))
      fireEvent.change(screen.getByTestId('identities-editor-signature'), { target: { value: 'Regards, A' } })
      fireEvent.click(screen.getByTestId('identities-editor-save'))
      const next = onChange.mock.calls[0][0]
      expect(next[0].signature).toBe('Regards, A')
    })
  })
})
