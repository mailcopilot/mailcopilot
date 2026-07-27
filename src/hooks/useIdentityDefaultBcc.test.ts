// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Identity } from '@mailcopilot/types'
import { computeNextBccForIdentity, useIdentityDefaultBcc } from './useIdentityDefaultBcc'

function makeIdentity(partial: Partial<Identity> & { id: string; email: string }): Identity {
  return {
    id: partial.id,
    email: partial.email,
    displayName: partial.displayName ?? partial.email.split('@')[0],
    signature: partial.signature,
    defaultBcc: partial.defaultBcc,
    isDefault: partial.isDefault ?? false,
  }
}

describe('computeNextBccForIdentity', () => {
  it('fills empty Bcc with the new identity default', () => {
    expect(computeNextBccForIdentity('', '', 'b@x.com')).toBe('b@x.com')
  })

  it('keeps empty when both identities have no default', () => {
    expect(computeNextBccForIdentity('', '', '')).toBe('')
  })

  it('replaces Bcc that equals previous default with new default (identity swap)', () => {
    expect(computeNextBccForIdentity('a@x.com', 'a@x.com', 'b@x.com')).toBe('b@x.com')
  })

  it('clears Bcc when switching to identity without a default and current Bcc was inherited', () => {
    expect(computeNextBccForIdentity('a@x.com', 'a@x.com', '')).toBe('')
  })

  it('leaves user-typed Bcc alone when it differs from previous default', () => {
    expect(computeNextBccForIdentity('custom@x.com', 'a@x.com', 'b@x.com')).toBe('custom@x.com')
  })

  it('leaves user-typed Bcc alone when there was no previous default', () => {
    // User typed a Bcc on a fresh compose; switching identity must not
    // silently wipe that value.
    expect(computeNextBccForIdentity('custom@x.com', '', 'b@x.com')).toBe('custom@x.com')
  })

  it('compares on trimmed values to tolerate stray whitespace', () => {
    // `setBcc` may be called with a user-typed value that has trailing
    // whitespace; the "inherited" detection should still recognise it as
    // equal to the previous default.
    expect(computeNextBccForIdentity(' a@x.com ', 'a@x.com', 'b@x.com')).toBe('b@x.com')
  })
})

describe('useIdentityDefaultBcc', () => {
  const alpha = makeIdentity({ id: 'a', email: 'a@x.com', defaultBcc: 'a-bcc@x.com' })
  const beta = makeIdentity({ id: 'b', email: 'b@x.com', defaultBcc: 'b-bcc@x.com' })
  const gamma = makeIdentity({ id: 'c', email: 'c@x.com' })

  it('applies the initial identity defaultBcc when Bcc starts empty', () => {
    const setBcc = vi.fn()
    renderHook(() => useIdentityDefaultBcc(alpha, '', setBcc))
    expect(setBcc).toHaveBeenCalledWith('a-bcc@x.com')
  })

  it('does not call setBcc when Bcc already matches the target', () => {
    const setBcc = vi.fn()
    renderHook(() => useIdentityDefaultBcc(alpha, 'a-bcc@x.com', setBcc))
    expect(setBcc).not.toHaveBeenCalled()
  })

  it('swaps Bcc to the new identity default when user never overrode it', () => {
    const setBcc = vi.fn()
    const { rerender } = renderHook(
      (props: { identity: Identity | null; bcc: string }) =>
        useIdentityDefaultBcc(props.identity, props.bcc, setBcc),
      { initialProps: { identity: alpha, bcc: '' } },
    )
    // Initial fill.
    expect(setBcc).toHaveBeenCalledWith('a-bcc@x.com')
    setBcc.mockClear()
    // User "applied" the initial fill — parent forwards it back.
    rerender({ identity: beta, bcc: 'a-bcc@x.com' })
    expect(setBcc).toHaveBeenCalledWith('b-bcc@x.com')
  })

  it('preserves user-typed Bcc across identity changes', () => {
    const setBcc = vi.fn()
    const { rerender } = renderHook(
      (props: { identity: Identity | null; bcc: string }) =>
        useIdentityDefaultBcc(props.identity, props.bcc, setBcc),
      { initialProps: { identity: alpha, bcc: 'custom@x.com' } },
    )
    expect(setBcc).not.toHaveBeenCalled()
    rerender({ identity: beta, bcc: 'custom@x.com' })
    expect(setBcc).not.toHaveBeenCalled()
  })

  it('clears Bcc when switching from an identity with default to one without, if user did not override', () => {
    const setBcc = vi.fn()
    const { rerender } = renderHook(
      (props: { identity: Identity | null; bcc: string }) =>
        useIdentityDefaultBcc(props.identity, props.bcc, setBcc),
      { initialProps: { identity: alpha, bcc: '' } },
    )
    setBcc.mockClear()
    rerender({ identity: gamma, bcc: 'a-bcc@x.com' })
    expect(setBcc).toHaveBeenCalledWith('')
  })

  it('does nothing when identity is null', () => {
    const setBcc = vi.fn()
    renderHook(() => useIdentityDefaultBcc(null, '', setBcc))
    expect(setBcc).not.toHaveBeenCalled()
  })
})
