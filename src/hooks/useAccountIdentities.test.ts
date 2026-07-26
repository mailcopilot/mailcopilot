// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAccountIdentities } from './useAccountIdentities'
import type { AccountMeta } from '../../packages/types'

function makeMeta(overrides: Partial<AccountMeta> = {}): AccountMeta {
  return {
    id: 1,
    providerId: 'generic-imap',
    transportType: 'imap-smtp',
    imap: { host: 'imap.example.com', port: 993, secure: true, user: 'user@example.com' },
    smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'user@example.com' },
    identities: [
      { id: 'id-1', displayName: 'User', email: 'user@example.com', isDefault: true },
    ],
    ...overrides,
  }
}

describe('useAccountIdentities', () => {
  it('returns empty array when meta is undefined', () => {
    const { result } = renderHook(() => useAccountIdentities(undefined))
    expect(result.current).toEqual([])
  })

  it('collects primary identity email', () => {
    const meta = makeMeta()
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('user@example.com')
  })

  it('includes meta.email when present', () => {
    const meta = makeMeta({ email: 'toplevel@example.com' })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('toplevel@example.com')
  })

  it('includes smtp.user when different from identity email', () => {
    const meta = makeMeta({
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'smtp-login@example.com' },
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('smtp-login@example.com')
  })

  it('includes imap.user when different from other addresses', () => {
    const meta = makeMeta({
      imap: { host: 'imap.example.com', port: 993, secure: true, user: 'imap-login@example.com' },
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('imap-login@example.com')
  })

  it('normalizes addresses to lowercase and trims whitespace', () => {
    const meta = makeMeta({
      identities: [
        { id: 'id-1', displayName: 'User', email: '  USER@Example.COM  ', isDefault: true },
      ],
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('user@example.com')
    expect(result.current).not.toContain('  USER@Example.COM  ')
  })

  it('deduplicates identical addresses from multiple sources', () => {
    // smtp.user and imap.user both equal the identity email
    const meta = makeMeta({
      email: 'user@example.com',
      identities: [
        { id: 'id-1', displayName: 'User', email: 'user@example.com', isDefault: true },
      ],
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    // Should appear exactly once
    expect(result.current.filter(e => e === 'user@example.com').length).toBe(1)
  })

  it('collects all alias identities from identities array', () => {
    const meta = makeMeta({
      identities: [
        { id: 'id-1', displayName: 'Main', email: 'main@example.com', isDefault: true },
        { id: 'id-2', displayName: 'Alias', email: 'alias@example.com', isDefault: false },
      ],
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).toContain('main@example.com')
    expect(result.current).toContain('alias@example.com')
  })

  it('filters out empty strings', () => {
    const meta = makeMeta({
      email: '',
      identities: [
        { id: 'id-1', displayName: 'User', email: 'user@example.com', isDefault: true },
      ],
    })
    const { result } = renderHook(() => useAccountIdentities(meta))
    expect(result.current).not.toContain('')
  })
})
