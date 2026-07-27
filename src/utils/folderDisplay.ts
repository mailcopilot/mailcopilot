import type { FolderRoles } from '../../packages/net/types'

/**
 * Strip the leading bracket-group prefix from a raw IMAP folder path.
 * Example: "[Gmail]/Sent Mail" → "Sent Mail"
 */
export function stripBracketPrefix(path: string): string {
  return path.replace(/^\[[^\]]+\]\//, '')
}

/**
 * Return a human-readable, role-aware folder label for display in the status
 * bar and other non-sidebar contexts (where we do not always have a full
 * Mailbox object with a `name` field).
 *
 * Resolution order:
 *  1. INBOX (case-insensitive) → i18n key `folders.inbox`
 *  2. Matches a known role in `roles` → i18n key for that role
 *  3. Strip `[…]/` bracket prefix from the raw path and use the remainder
 *
 * @param path   Raw IMAP folder path, e.g. "INBOX", "[Gmail]/Sent Mail"
 * @param roles  FolderRoles map from the current account (may be empty)
 * @param t      i18next `t` function
 */
export function prettyFolderName(
  path: string,
  roles: FolderRoles,
  t: (key: string) => string,
): string {
  const lower = path.toLowerCase()
  if (lower === 'inbox') return t('folders.inbox')
  if (roles.sent && roles.sent === path) return t('folders.sent')
  if (roles.drafts && roles.drafts === path) return t('folders.drafts')
  if (roles.trash && roles.trash === path) return t('folders.trash')
  if (roles.junk && roles.junk === path) return t('folders.junk')
  if (roles.archive && roles.archive === path) return t('folders.archive')
  return stripBracketPrefix(path)
}
