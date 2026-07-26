import { describe, expect, it } from 'vitest'
import type { Identity } from '@mailcopilot/types'
import { formatIdentityOption } from './identity'

function makeIdentity(partial: Partial<Identity> & { id: string }): Identity {
  return {
    id: partial.id,
    displayName: partial.displayName ?? '',
    email: partial.email ?? '',
    signature: partial.signature,
    defaultBcc: partial.defaultBcc,
    isDefault: partial.isDefault ?? false,
  }
}

describe('formatIdentityOption', () => {
  it('renders "Name <email>" when both are present and differ', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: 'Alice', email: 'alice@example.com' })))
      .toBe('Alice <alice@example.com>')
  })

  it('collapses to email alone when displayName equals email', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: 'alice@example.com', email: 'alice@example.com' })))
      .toBe('alice@example.com')
  })

  it('collapses to email when displayName equals email case-insensitively', () => {
    // Legacy synthesized identities sometimes store the email-case differently
    // from displayName (e.g. "ALICE@example.com" vs "alice@example.com"). The
    // duplicate-display guard must not flip on just because of case.
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: 'ALICE@example.com', email: 'alice@example.com' })))
      .toBe('alice@example.com')
  })

  it('returns email alone when displayName is empty', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: '', email: 'alice@example.com' })))
      .toBe('alice@example.com')
  })

  it('returns email alone when displayName is only whitespace', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: '   ', email: 'alice@example.com' })))
      .toBe('alice@example.com')
  })

  it('trims whitespace around displayName and email for the duplicate check', () => {
    // Ensures trailing/leading whitespace doesn't defeat the "name equals
    // email" collapse rule. Output itself is the unpadded original email.
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: ' alice@example.com ', email: ' alice@example.com ' })))
      .toBe('alice@example.com')
  })

  it('returns displayName alone when email is empty', () => {
    // Not a shape we expect on a persisted Identity (read schema enforces
    // non-empty email), but the formatter should still behave gracefully
    // rather than render "Alice <>".
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: 'Alice', email: '' })))
      .toBe('Alice')
  })

  it('returns empty string when both displayName and email are empty', () => {
    expect(formatIdentityOption(makeIdentity({ id: 'a', displayName: '', email: '' })))
      .toBe('')
  })
})
