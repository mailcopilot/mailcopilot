export type Mailbox = {
  path: string
  name: string
  specialUse?: string | null
  unread?: number
}

export type FolderHeaderSyncMode = 'full' | 'on_open' | 'period' | 'off'
export type FolderOfflineMode = 'off' | 'period' | 'full'

export type FolderPreference = {
  accountId: number
  folderPath: string
  visible: boolean
  includeInBadges: boolean
  headerSyncMode: FolderHeaderSyncMode
  headerSyncDays?: number
  offlineMode: FolderOfflineMode
  offlineDays?: number
  icon?: string
  /**
   * §2.15-ter: when false, new headers from sync skip FTS5 indexing and
   * are excluded from search results. The row stays in the messages table
   * so the user can still view/manage Junk/Spam/Trash from the list view.
   * Auto-disabled for folders with role 'junk' / 'spam' / 'trash' on first
   * registration; otherwise default true.
   */
  indexInSearch: boolean
}

export type TlsPin = {
  id: number
  accountId: number
  host: string
  port: number
  fingerprintSha256: string
  createdAt: string
}

/** Mapping of standard roles to actual folders on the IMAP server */
export type FolderRoles = {
  archive?: string
  trash?: string
  sent?: string
  drafts?: string
  junk?: string
}
