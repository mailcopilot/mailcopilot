import { describe, expect, it } from 'vitest'
import type { AccountMeta } from '@mailcopilot/types'
import { resolveFromEmailFromMeta } from './composeFromEmail'

/**
 * Tests for §2.15 Compose Send-button fix (85d6221). Reply/forward flows
 * hit compose:init with hasInit=true, and before the fix the identities
 * fetch was gated on !hasInit → `fromEmail` stayed '' → Send stayed
 * disabled until the user manually re-picked the account.
 *
 * The resolver itself is the pure piece of that fix. The Compose.tsx
 * side is a call-site change (now calls this helper in every
 * compose:init branch, not just fresh new-compose). Covered at
 * integration level by the existing Compose e2e smoke, which sees a
 * populated fromEmail after reply/forward flows.
 */
describe('resolveFromEmailFromMeta', () => {
  const base: AccountMeta = {
    id: 1,
    email: undefined,
    imap: { host: 'imap.example.com', port: 993, secure: true, user: 'imap-user@example.com' },
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'smtp-user@example.com' },
  } as AccountMeta

  it('prefers meta.email when set', () => {
    const meta: AccountMeta = { ...base, email: 'display@example.com' }
    expect(resolveFromEmailFromMeta(meta)).toBe('display@example.com')
  })

  it('falls back to smtp.user when email is empty', () => {
    expect(resolveFromEmailFromMeta({ ...base, email: '' })).toBe('smtp-user@example.com')
  })

  it('falls back to smtp.user when email is undefined', () => {
    expect(resolveFromEmailFromMeta(base)).toBe('smtp-user@example.com')
  })

  it('falls back to imap.user when email and smtp.user are both empty', () => {
    const meta: AccountMeta = {
      ...base,
      email: '',
      smtp: { ...base.smtp, user: '' },
    }
    expect(resolveFromEmailFromMeta(meta)).toBe('imap-user@example.com')
  })

  it('returns empty string when meta is null — Send stays disabled until retry', () => {
    // This is the pre-fix state of reply/forward: without a meta fetch,
    // fromEmail stayed ''. The new compose:init handler now always fetches,
    // but the helper still has to handle null defensively (racing fetches
    // may return undefined before canceling).
    expect(resolveFromEmailFromMeta(null)).toBe('')
  })

  it('returns empty string when meta is undefined', () => {
    expect(resolveFromEmailFromMeta(undefined)).toBe('')
  })

  it('returns empty string when all candidate fields are empty (never crashes)', () => {
    const meta: AccountMeta = {
      ...base,
      email: '',
      smtp: { ...base.smtp, user: '' },
      imap: { ...base.imap, user: '' },
    }
    expect(resolveFromEmailFromMeta(meta)).toBe('')
  })

  it('priority order survives when multiple fields are present', () => {
    // Regression guard: email must win over smtp.user, which must win over
    // imap.user. If this ordering ever flips, aliased identities on
    // Gmail/Outlook would silently send from the wrong address.
    const meta: AccountMeta = {
      ...base,
      email: 'alias@example.com',
      smtp: { ...base.smtp, user: 'real-smtp@example.com' },
      imap: { ...base.imap, user: 'real-imap@example.com' },
    }
    expect(resolveFromEmailFromMeta(meta)).toBe('alias@example.com')
  })
})
