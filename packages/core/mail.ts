import type { FolderRoles, MailAddress, MessageEnvelope, Mailbox } from '@mailcopilot/types'

// --- Addresses ---

export function addrToString(a: MailAddress): string {
  const name = (a.name || '').trim()
  const address = (a.address || '').trim()
  if (name && address) return `${name} <${address}>`
  return address || name || ''
}

export function addrListToString(list?: MailAddress[]): string {
  if (!list || list.length === 0) return ''
  return list.map(addrToString).filter(Boolean).join(', ')
}

/**
 * Returns a tooltip string for a single address: "Name <email>" when both are
 * present, otherwise whichever part is available. Used by RecipientList chips.
 */
export function addrTooltip(a: MailAddress): string {
  return addrToString(a)
}

/**
 * Returns the display label for a recipient chip: the name if available,
 * otherwise the email address or empty string.
 */
export function addrDisplayName(a: MailAddress): string {
  const name = (a.name || '').trim()
  const address = (a.address || '').trim()
  return name || address || ''
}

export function extractEmails(list?: MailAddress[]): string[] {
  if (!list) return []
  return list.map(a => (a.address || '').trim()).filter(Boolean)
}

export function uniqEmails(emails: string[]): string[] {
  const seen = new Set<string>()
  const res: string[] = []
  for (const e of emails) {
    const key = e.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    res.push(e)
  }
  return res
}

/**
 * Computes reply recipients from an envelope. For "reply" mode, To = Reply-To
 * (or From when Reply-To absent) and CC = undefined. For "replyAll" mode,
 * CC pools original From + To + CC, with the user's own address and the
 * reply target filtered out to avoid double-include.
 *
 * Bug reported 2026-04-21 (d767639): when Reply-To != From (mailing lists,
 * alias redirects, "no-reply" senders), the original sender (env.from) was
 * dropped because CC only considered env.to + env.cc. uniqEmails() dedupes
 * the common Reply-To == From case, so adding env.from to the pool is safe.
 *
 * Pure function: all inputs explicit, no DOM / network. `me` should already
 * be lowercased by the caller; `replyTo` is compared case-insensitively.
 */
export function computeReplyRecipients(
  env: MessageEnvelope | null | undefined,
  mode: 'reply' | 'replyAll',
  me: string,
): { to: string; cc: string | undefined; originalRecipients: string[] } {
  const replyToList = (env?.replyTo && env.replyTo.length > 0) ? env.replyTo : env?.from
  const replyTo = uniqEmails(extractEmails(replyToList))[0] || ''
  const meLower = (me || '').toLowerCase()
  const replyToLower = replyTo.toLowerCase()

  const pool = uniqEmails([
    ...extractEmails(env?.from),
    ...extractEmails(env?.to),
    ...extractEmails(env?.cc),
  ])

  const cc = mode === 'replyAll'
    ? pool
        .filter(e => e.toLowerCase() !== meLower && e.toLowerCase() !== replyToLower)
        .join(', ') || undefined
    : undefined

  return { to: replyTo, cc, originalRecipients: pool }
}

// --- Subject ---

/** Adds a prefix (Re/Fwd) to the subject if not already present */
export function prefixSubject(prefix: string, subject: string): string {
  const s = subject || ''
  // Escape regex special characters to prevent injection with non-standard prefixes
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*:`, 'i')
  if (re.test(s)) return s
  return s ? `${prefix}: ${s}` : `${prefix}:`
}

// --- HTML / text (pure, no DOM) ---

export function quoteText(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n')
}

export function normalizeCid(cid: string): string {
  const c = (cid || '').trim()
  return c.replace(/^<+/, '').replace(/>+$/, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces src="cid:..." references with data: URIs (inline images).
 *
 * A `Map` is the preferred container and the only one that can carry every
 * `Content-ID` a sender may write: a `Content-ID` is attacker-controlled data,
 * and in a plain object the name `__proto__` is not a data slot but an
 * inherited setter — `obj['__proto__'] = uri` creates no own property, so
 * `Object.entries` never yields the pair and the substitution silently does
 * not happen. Plain objects are still accepted for the callers that build
 * their map from keys they control themselves; own enumerable properties are
 * read, so a `Object.create(null)` record works too.
 */
export function replaceCidImages(
  html: string,
  cidToDataUri: Record<string, string> | ReadonlyMap<string, string>,
): string {
  let out = html
  const pairs: Iterable<[string, string]> =
    cidToDataUri instanceof Map ? cidToDataUri.entries() : Object.entries(cidToDataUri)
  for (const [cidRaw, dataUri] of pairs) {
    const cid = normalizeCid(cidRaw)
    if (!cid || !dataUri) continue
    const re = new RegExp(`cid:(?:<)?${escapeRegExp(cid)}(?:>)?`, 'gi')
    out = out.replace(re, dataUri)
  }
  return out
}

// --- Formatting ---

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`
}

// --- Smart date for mail list ---

/** Formats message date: today->time, yesterday->"Yesterday", this week->weekday, this year->day month, older->dd.mm.yy */
export function formatSmartDate(isoDate: string, t: (key: string) => string): { display: string; full: string } {
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return { display: isoDate, full: isoDate }

  const now = new Date()
  const full = d.toLocaleString()

  // Today -> time only
  if (d.toDateString() === now.toDateString()) {
    return { display: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), full }
  }

  // Yesterday
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return { display: t('mail.date.yesterday'), full }
  }

  // This week (up to 7 days ago) -> weekday
  const diffMs = now.getTime() - d.getTime()
  if (diffMs < 7 * 86_400_000 && diffMs > 0) {
    return { display: d.toLocaleDateString(undefined, { weekday: 'short' }), full }
  }

  // This year -> day month
  if (d.getFullYear() === now.getFullYear()) {
    return { display: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), full }
  }

  // Previous year and older -> day month year
  return { display: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), full }
}

// --- Avatars ---

/** Get initials from the sender address */
export function getInitials(from: string): string {
  const clean = from.replace(/<[^>]+>/g, '').trim()
  const namePart = clean.includes('@') ? clean.split('@')[0] : clean
  const parts = namePart.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (parts[0] || '?').substring(0, 2).toUpperCase()
}

/** Stable avatar color based on the address */
export function getAvatarColor(from: string): string {
  let hash = 0
  for (let i = 0; i < from.length; i++) hash = from.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export const AVATAR_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'] as const

export function getPaletteColor(index: number): string {
  const i = Math.abs(Math.floor(index)) % AVATAR_COLORS.length
  return AVATAR_COLORS[i]
}

// --- Folders ---

const ROLE_SORT_ORDER: (keyof FolderRoles)[] = ['sent', 'drafts', 'archive', 'trash', 'junk']

/** Sort folders: INBOX -> roles in order -> others by name */
export function sortFolders(folders: Mailbox[], roles: FolderRoles): Mailbox[] {
  const rolePathToOrder = new Map<string, number>()
  rolePathToOrder.set('INBOX', 0)
  for (let i = 0; i < ROLE_SORT_ORDER.length; i++) {
    const role = ROLE_SORT_ORDER[i]
    const p = roles[role]
    if (p) rolePathToOrder.set(p, i + 1)
  }
  return [...folders].sort((a, b) => {
    const oa = rolePathToOrder.get(a.path) ?? 100
    const ob = rolePathToOrder.get(b.path) ?? 100
    if (oa !== ob) return oa - ob
    if (oa === 100 && ob === 100) return a.name.localeCompare(b.name)
    return 0
  })
}

/** Determine folder role: by specialUse or by mapping through roles */
export function getFolderRole(path: string, specialUse: string | null | undefined, roles: FolderRoles): string | null {
  if (specialUse) return specialUse
  if (path === 'INBOX') return '\\Inbox'
  if (roles.archive === path) return '\\Archive'
  if (roles.trash === path) return '\\Trash'
  if (roles.sent === path) return '\\Sent'
  if (roles.drafts === path) return '\\Drafts'
  if (roles.junk === path) return '\\Junk'
  return null
}

/** Localized folder name */
export function folderLabel(name: string, role: string | null, t: (key: string) => string): string {
  switch (role) {
    case '\\Inbox': return t('folders.inbox')
    case '\\Sent': return t('folders.sent')
    case '\\Drafts': return t('folders.drafts')
    case '\\Trash': return t('folders.trash')
    case '\\Junk': return t('folders.junk')
    case '\\Archive': return t('folders.archive')
    default: return name
  }
}
