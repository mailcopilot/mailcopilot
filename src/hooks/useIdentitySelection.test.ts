// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Identity } from '@mailcopilot/types'
import {
  extractEmailsFromRecipients,
  pickReplyIdentity,
  findDefaultIdentity,
  useIdentitySelection,
} from './useIdentitySelection'

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

describe('extractEmailsFromRecipients', () => {
  it('parses a bare comma-separated list', () => {
    expect(extractEmailsFromRecipients('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('parses Name <email> form', () => {
    expect(extractEmailsFromRecipients('Alice <alice@x.com>, "Bob Zero" <bob@y.com>'))
      .toEqual(['alice@x.com', 'bob@y.com'])
  })

  it('lowercases addresses for case-insensitive matching', () => {
    expect(extractEmailsFromRecipients('ALICE@X.COM')).toEqual(['alice@x.com'])
  })

  it('returns empty array on empty/nullish input', () => {
    expect(extractEmailsFromRecipients('')).toEqual([])
    expect(extractEmailsFromRecipients(null)).toEqual([])
    expect(extractEmailsFromRecipients(undefined)).toEqual([])
  })
})

describe('findDefaultIdentity', () => {
  it('returns the flagged default', () => {
    const ids = [
      makeIdentity({ id: 'a', email: 'a@x.com' }),
      makeIdentity({ id: 'b', email: 'b@x.com', isDefault: true }),
    ]
    expect(findDefaultIdentity(ids)?.id).toBe('b')
  })

  it('falls back to first when no default flag', () => {
    const ids = [makeIdentity({ id: 'a', email: 'a@x.com' })]
    expect(findDefaultIdentity(ids)?.id).toBe('a')
  })

  it('returns null on empty list', () => {
    expect(findDefaultIdentity([])).toBeNull()
  })
})

describe('pickReplyIdentity', () => {
  const identities: Identity[] = [
    makeIdentity({ id: 'work', email: 'me@work.com', isDefault: true }),
    makeIdentity({ id: 'alias', email: 'alias@work.com' }),
    makeIdentity({ id: 'personal', email: 'me@home.com' }),
  ]

  it('matches identity on original To', () => {
    expect(pickReplyIdentity(identities, 'Name <alias@work.com>', null)?.id).toBe('alias')
  })

  it('matches identity on original Cc', () => {
    expect(pickReplyIdentity(identities, 'other@somewhere.com', 'me@home.com')?.id).toBe('personal')
  })

  it('matches case-insensitively', () => {
    expect(pickReplyIdentity(identities, 'ME@WORK.COM', null)?.id).toBe('work')
  })

  it('returns null when no address matches any identity', () => {
    expect(pickReplyIdentity(identities, 'stranger@elsewhere.com', 'foo@bar')).toBeNull()
  })

  it('returns null when both to and cc are empty', () => {
    expect(pickReplyIdentity(identities, null, null)).toBeNull()
  })
})

describe('useIdentitySelection', () => {
  const identities: Identity[] = [
    makeIdentity({ id: 'work', email: 'me@work.com', isDefault: true }),
    makeIdentity({ id: 'alias', email: 'alias@work.com' }),
    makeIdentity({ id: 'personal', email: 'me@home.com' }),
  ]

  it('initial selection is the default identity on a new compose', () => {
    const { result } = renderHook(() => useIdentitySelection({ identities }))
    expect(result.current.selectedId).toBe('work')
    expect(result.current.selectedIdentity?.email).toBe('me@work.com')
    expect(result.current.autoMatched).toBe(false)
  })

  it('auto-matches identity from original To on reply', () => {
    const { result } = renderHook(() =>
      useIdentitySelection({ identities, originalTo: 'alias@work.com', originalCc: null }),
    )
    expect(result.current.selectedId).toBe('alias')
    expect(result.current.autoMatched).toBe(true)
  })

  it('auto-matches identity from original Cc on reply', () => {
    const { result } = renderHook(() =>
      useIdentitySelection({ identities, originalTo: 'other@elsewhere.com', originalCc: 'me@home.com' }),
    )
    expect(result.current.selectedId).toBe('personal')
    expect(result.current.autoMatched).toBe(true)
  })

  it('falls back to default when no identity matches reply context', () => {
    const { result } = renderHook(() =>
      useIdentitySelection({ identities, originalTo: 'stranger@x.com' }),
    )
    expect(result.current.selectedId).toBe('work')
    expect(result.current.autoMatched).toBe(false)
  })

  it('manual override flips autoMatched to false', () => {
    const { result } = renderHook(() =>
      useIdentitySelection({ identities, originalTo: 'alias@work.com' }),
    )
    expect(result.current.autoMatched).toBe(true)
    act(() => result.current.setSelectedId('personal'))
    expect(result.current.selectedId).toBe('personal')
    expect(result.current.autoMatched).toBe(false)
  })

  it('keeps selection when identities array reference changes but ids match', () => {
    const { result, rerender } = renderHook(
      (props: { identities: Identity[] }) => useIdentitySelection({ identities: props.identities }),
      { initialProps: { identities } },
    )
    act(() => result.current.setSelectedId('alias'))
    expect(result.current.selectedId).toBe('alias')

    // Parent re-renders with a new array (same ids) — selection should stick.
    rerender({ identities: identities.map(i => ({ ...i })) })
    expect(result.current.selectedId).toBe('alias')
  })

  it('returns null selection when identities list is empty', () => {
    const { result } = renderHook(() => useIdentitySelection({ identities: [] }))
    expect(result.current.selectedId).toBeNull()
    expect(result.current.selectedIdentity).toBeNull()
  })

  it('reconciles selection to default when currently-selected identity is removed from the list', () => {
    // User picked "alias", then Settings removed that alias. Hook must not
    // cling to a stale id — it should fall back to initial (default) pick.
    const { result, rerender } = renderHook(
      (props: { identities: Identity[] }) => useIdentitySelection({ identities: props.identities }),
      { initialProps: { identities } },
    )
    act(() => result.current.setSelectedId('alias'))
    expect(result.current.selectedId).toBe('alias')

    const withoutAlias = identities.filter(i => i.id !== 'alias')
    rerender({ identities: withoutAlias })
    expect(result.current.selectedId).toBe('work')
  })

  it('selectedIdentity is null when selectedId no longer resolves against current list', () => {
    // Belt-and-suspenders: even if ids list changes without a reconcile cycle
    // (e.g. parent mutates the array in place), accessing `selectedIdentity`
    // via the find() lookup must not throw and must surface null.
    const { result, rerender } = renderHook(
      (props: { identities: Identity[] }) => useIdentitySelection({ identities: props.identities }),
      { initialProps: { identities } },
    )
    // Empty out the list entirely — selectedIdentity memo must recompute to null.
    rerender({ identities: [] })
    expect(result.current.selectedIdentity).toBeNull()
  })

  it('does not reset autoMatched back to true on manual override even when reply context persists', () => {
    // Regression guard: once user explicitly picks an identity, hint must
    // stay hidden for the lifetime of the compose — even if the effect
    // re-runs because of an unrelated prop change.
    const { result, rerender } = renderHook(
      (props: { identities: Identity[]; to: string | null }) =>
        useIdentitySelection({ identities: props.identities, originalTo: props.to }),
      { initialProps: { identities, to: 'alias@work.com' } },
    )
    expect(result.current.autoMatched).toBe(true)
    act(() => result.current.setSelectedId('personal'))
    expect(result.current.autoMatched).toBe(false)
    // Parent re-renders (e.g. React 18 strict-mode second pass): autoMatched
    // must stay false.
    rerender({ identities, to: 'alias@work.com' })
    expect(result.current.autoMatched).toBe(false)
  })

  describe('initialIdentityId', () => {
    it('honours initialIdentityId when it exists in the list', () => {
      // Queue → cancel → edit path: Compose already knows which identity the
      // user picked, hook must trust that hint over the default-identity pick.
      const { result } = renderHook(() =>
        useIdentitySelection({ identities, initialIdentityId: 'alias' }),
      )
      expect(result.current.selectedId).toBe('alias')
      expect(result.current.autoMatched).toBe(false)
    })

    it('wins over reply-match when both are present', () => {
      // If the user previously queued from an explicit alias, editing the
      // cancelled send should not re-run reply-match and overwrite that
      // choice — the stored identity is the source of truth.
      const { result } = renderHook(() =>
        useIdentitySelection({
          identities,
          originalTo: 'me@work.com',
          initialIdentityId: 'personal',
        }),
      )
      expect(result.current.selectedId).toBe('personal')
      expect(result.current.autoMatched).toBe(false)
    })

    it('falls back to default pick when initialIdentityId does not exist', () => {
      // Identity was deleted between queueing and editing → never pin a
      // ghost id; fall through to the normal pick.
      const { result } = renderHook(() =>
        useIdentitySelection({ identities, initialIdentityId: 'deleted-id' }),
      )
      expect(result.current.selectedId).toBe('work')
      expect(result.current.autoMatched).toBe(false)
    })

    it('falls back to reply-match when initialIdentityId is missing and reply context hits', () => {
      const { result } = renderHook(() =>
        useIdentitySelection({
          identities,
          originalTo: 'alias@work.com',
          initialIdentityId: 'gone',
        }),
      )
      expect(result.current.selectedId).toBe('alias')
      expect(result.current.autoMatched).toBe(true)
    })
  })
})
