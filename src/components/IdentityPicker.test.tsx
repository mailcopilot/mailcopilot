// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Identity } from '@mailcopilot/types'
import IdentityPicker from './IdentityPicker'
import { formatIdentityOption } from '../utils/identity'

afterEach(cleanup)

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

describe('formatIdentityOption', () => {
  it('formats as "DisplayName <email>" when both are present and differ', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', email: 'a@x.com', displayName: 'Alice' })))
      .toBe('Alice <a@x.com>')
  })

  it('falls back to email alone when displayName equals email', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', email: 'a@x.com', displayName: 'a@x.com' })))
      .toBe('a@x.com')
  })

  it('handles empty displayName gracefully', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', email: 'a@x.com', displayName: '' })))
      .toBe('a@x.com')
  })
})

describe('IdentityPicker', () => {
  const identities: Identity[] = [
    makeIdentity({ id: 'work', email: 'me@work.com', displayName: 'Me Work', isDefault: true }),
    makeIdentity({ id: 'alias', email: 'alias@work.com', displayName: 'Alias' }),
  ]

  it('renders one option per identity', () => {
    render(<IdentityPicker identities={identities} selectedId="work" onChange={() => undefined} />)
    const select = screen.getByTestId('identity-picker') as HTMLSelectElement
    expect(select.options.length).toBe(2)
    expect(select.options[0].textContent).toContain('me@work.com')
    expect(select.options[1].textContent).toContain('alias@work.com')
  })

  it('renders a single option when only one identity exists', () => {
    const one = [identities[0]]
    render(<IdentityPicker identities={one} selectedId="work" onChange={() => undefined} />)
    const select = screen.getByTestId('identity-picker') as HTMLSelectElement
    expect(select.options.length).toBe(1)
    expect(select.value).toBe('work')
  })

  it('fires onChange with the newly-selected id', () => {
    const onChange = vi.fn()
    render(<IdentityPicker identities={identities} selectedId="work" onChange={onChange} />)
    const select = screen.getByTestId('identity-picker') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'alias' } })
    expect(onChange).toHaveBeenCalledWith('alias')
  })

  it('respects the disabled prop', () => {
    render(<IdentityPicker identities={identities} selectedId="work" onChange={() => undefined} disabled />)
    const select = screen.getByTestId('identity-picker') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('renders the accessible label when provided', () => {
    render(<IdentityPicker identities={identities} selectedId="work" onChange={() => undefined} label="From identity" />)
    expect(screen.getByText('From identity')).toBeTruthy()
  })

  it('disables the control when identities list is empty', () => {
    render(<IdentityPicker identities={[]} selectedId={null} onChange={() => undefined} />)
    const select = screen.getByTestId('identity-picker') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })
})
