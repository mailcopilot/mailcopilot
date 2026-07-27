// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import AccountAvatar from './AccountAvatar'
import type { AccountMeta } from '../../packages/net/types'

afterEach(cleanup)

// sha256hex is used only in gravatar mode — mock it so tests run without
// the Web Crypto API subtlety in jsdom.
vi.mock('../utils/gravatar', () => ({
  sha256hex: vi.fn().mockResolvedValue('deadbeef'),
  clearGravatarCache: vi.fn(),
}))

function makeAccount(overrides: Partial<AccountMeta> = {}): AccountMeta {
  return {
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    providerId: 'generic-imap',
    transportType: 'imap-smtp',
    imap: { host: 'imap.example.com', port: 993, secure: true, user: 'test@example.com' },
    smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'test@example.com' },
    identities: [{ id: 'default', displayName: 'Test User', email: 'test@example.com', isDefault: true }],
    ...overrides,
  }
}

describe('AccountAvatar', () => {
  describe('initials mode', () => {
    it('renders computed initials when no avatarMode is set', () => {
      const { container } = render(
        React.createElement(AccountAvatar, { account: makeAccount() }),
      )
      const avatar = container.querySelector('.account-avatar')
      expect(avatar).toBeTruthy()
      expect(avatar!.textContent).toContain('TU') // initials from "Test User"
    })

    it('renders custom avatarInitials when provided', () => {
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarInitials: 'JD' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      expect(avatar!.textContent).toContain('JD')
    })

    it('renders initials for avatarMode=initials', () => {
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarMode: 'initials' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      expect(avatar).toBeTruthy()
      // No icon SVG should be present
      expect(avatar!.querySelector('svg')).toBeNull()
    })
  })

  describe('icon mode (uiaudit.8)', () => {
    it('renders an SVG icon for a known avatarIcon', () => {
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarMode: 'icon', avatarIcon: 'star' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      expect(avatar!.querySelector('svg')).not.toBeNull()
    })

    it('falls back to initials when avatarIcon is empty string', () => {
      // Regression for uiaudit.8: before the fix, getAvatarIcon('') returned
      // the Mail icon as fallback, so the user saw a Mail icon instead of their
      // initials whenever avatarIcon was empty or unrecognised.
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarMode: 'icon', avatarIcon: '' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      // Should show text initials (no SVG from the icon branch)
      expect(avatar!.textContent).toContain('TU')
    })

    it('falls back to initials when avatarIcon is an unknown/legacy name', () => {
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarMode: 'icon', avatarIcon: 'unknown-legacy-icon' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      expect(avatar!.textContent).toContain('TU')
    })

    it('does not use Mail icon as silent fallback for unrecognised icon name', () => {
      // Before the fix: AccountAvatar would render the Mail lucide icon whenever
      // the icon name was not in AVATAR_ICONS. The Mail icon has a specific SVG
      // path element — if the avatar contains an SVG child it is showing an icon
      // rather than initials, which is the incorrect behaviour for an unrecognised
      // icon name.
      const { container } = render(
        React.createElement(AccountAvatar, {
          account: makeAccount({ avatarMode: 'icon', avatarIcon: 'nonexistent' }),
        }),
      )
      const avatar = container.querySelector('.account-avatar')
      // Must show text, not icon
      expect(avatar!.querySelector('svg')).toBeNull()
    })
  })
})
