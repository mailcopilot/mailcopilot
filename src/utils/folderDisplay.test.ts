import { describe, it, expect } from 'vitest'
import { prettyFolderName, stripBracketPrefix } from './folderDisplay'
import type { FolderRoles } from '../../packages/net/types'

const t = (key: string) => key

describe('stripBracketPrefix', () => {
  it('strips [Gmail]/ prefix', () => {
    expect(stripBracketPrefix('[Gmail]/Sent Mail')).toBe('Sent Mail')
  })

  it('strips [IMAP]/ prefix', () => {
    expect(stripBracketPrefix('[IMAP]/Drafts')).toBe('Drafts')
  })

  it('leaves paths without bracket prefix unchanged', () => {
    expect(stripBracketPrefix('INBOX')).toBe('INBOX')
    expect(stripBracketPrefix('Sent')).toBe('Sent')
  })

  it('does not strip inner brackets — only leading ones', () => {
    expect(stripBracketPrefix('Folder/Sub[folder]')).toBe('Folder/Sub[folder]')
  })

  it('does not strip bracket group without trailing slash', () => {
    // "[Gmail]Sent" is malformed — no separator slash, must be returned as-is
    expect(stripBracketPrefix('[Gmail]Sent')).toBe('[Gmail]Sent')
  })

  it('returns empty string for bracket-prefix-only path', () => {
    // "[Gmail]/" → strip prefix → empty string
    expect(stripBracketPrefix('[Gmail]/')).toBe('')
  })

  it('returns empty string unchanged', () => {
    expect(stripBracketPrefix('')).toBe('')
  })
})

describe('prettyFolderName', () => {
  const emptyRoles: FolderRoles = {}
  const roles: FolderRoles = {
    sent: '[Gmail]/Sent Mail',
    drafts: '[Gmail]/Drafts',
    trash: '[Gmail]/Trash',
    junk: '[Gmail]/Spam',
    archive: '[Gmail]/All Mail',
  }

  it('returns localised inbox for "INBOX"', () => {
    expect(prettyFolderName('INBOX', emptyRoles, t)).toBe('folders.inbox')
  })

  it('is case-insensitive for inbox', () => {
    expect(prettyFolderName('inbox', emptyRoles, t)).toBe('folders.inbox')
  })

  it('returns localised sent for matching sent role', () => {
    expect(prettyFolderName('[Gmail]/Sent Mail', roles, t)).toBe('folders.sent')
  })

  it('returns localised drafts for matching drafts role', () => {
    expect(prettyFolderName('[Gmail]/Drafts', roles, t)).toBe('folders.drafts')
  })

  it('returns localised trash for matching trash role', () => {
    expect(prettyFolderName('[Gmail]/Trash', roles, t)).toBe('folders.trash')
  })

  it('returns localised junk for matching junk role', () => {
    expect(prettyFolderName('[Gmail]/Spam', roles, t)).toBe('folders.junk')
  })

  it('returns localised archive for matching archive role', () => {
    expect(prettyFolderName('[Gmail]/All Mail', roles, t)).toBe('folders.archive')
  })

  it('strips bracket prefix for unmatched paths', () => {
    // "[Gmail]/All Mail" not in roles → strip prefix
    expect(prettyFolderName('[Gmail]/Some Folder', emptyRoles, t)).toBe('Some Folder')
  })

  it('returns path as-is when no bracket prefix and no role match', () => {
    expect(prettyFolderName('Custom Folder', emptyRoles, t)).toBe('Custom Folder')
  })

  it('does not confuse partial role matches', () => {
    // "[Gmail]/Sent" is NOT the same as "[Gmail]/Sent Mail"
    const narrowRoles: FolderRoles = { sent: '[Gmail]/Sent Mail' }
    expect(prettyFolderName('[Gmail]/Sent', narrowRoles, t)).toBe('Sent')
  })

  it('handles empty string path gracefully', () => {
    expect(prettyFolderName('', emptyRoles, t)).toBe('')
  })

  it('returns plain folder name for bracket-prefix-only path', () => {
    // "[Custom]/" → stripped to "" — edge case where server sends malformed path
    expect(prettyFolderName('[Custom]/', emptyRoles, t)).toBe('')
  })

  it('emoji in folder name is preserved', () => {
    expect(prettyFolderName('[Custom]/📨 Inbox Plus', emptyRoles, t)).toBe('📨 Inbox Plus')
  })
})
