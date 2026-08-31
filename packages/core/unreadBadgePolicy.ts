/**
 * §2.99 (review H2) — the ONE answer to "does this folder's unread count reach
 * a badge?".
 *
 * Two surfaces ask it: the in-app per-account badge (src/App.tsx) and the OS
 * badge / tray tooltip driven by the main process. When they answered it
 * separately they disagreed — main summed folders by the legacy
 * `hiddenUnreadFolders` setting plus role defaults, the renderer by the
 * per-folder `visible` / `includeInBadges` preferences the folder context menu
 * actually writes — so the taskbar could claim unread mail the app itself did
 * not show, contradicting docs/docs/settings/general.md.
 *
 * The rule, stated once:
 *   a folder counts when it is VISIBLE and INCLUDED IN BADGES, where
 *   "included" defaults to "this is the inbox" until the user says otherwise.
 *
 * Pure, so both processes can import it (packages/core has no DOM and no
 * electron).
 */

/** The two folder preferences that decide badge participation. */
export type FolderBadgePref = {
  visible?: boolean | null
  includeInBadges?: boolean | null
}

/** One (account, folder) unread bucket. */
export type BadgeUnreadRow = {
  accountId: number
  folder: string
  unread: number
}

/** Per-folder context the caller resolves from its own data source. */
export type BadgeFolderContext = {
  pref?: FolderBadgePref | null
  /** Role marker as produced by `getFolderRole` — `'\\Inbox'` and friends. */
  role?: string | null
}

/**
 * Does this folder contribute to badges?
 *
 * `visible: false` always wins — a folder the user hid from the sidebar must
 * not speak through the taskbar. An explicit `includeInBadges` is honoured in
 * both directions; only its ABSENCE falls back to the inbox default, which is
 * why the check is `typeof === 'boolean'` and not a truthiness test.
 */
export function isFolderCountedInBadges(context: BadgeFolderContext | null | undefined): boolean {
  const pref = context?.pref
  if ((pref?.visible ?? true) === false) return false
  if (typeof pref?.includeInBadges === 'boolean') return pref.includeInBadges
  return context?.role === '\\Inbox'
}

/**
 * Sum the rows that count, resolving each folder's context through `resolve`.
 *
 * Negative, NaN and zero counts are dropped rather than propagated: the sum
 * feeds an OS badge, and one bad row must not produce a nonsense total.
 */
export function sumBadgeUnread(
  rows: readonly BadgeUnreadRow[],
  resolve: (accountId: number, folder: string) => BadgeFolderContext | null | undefined,
): number {
  let total = 0
  for (const row of rows) {
    if (!Number.isFinite(row.unread) || row.unread <= 0) continue
    if (!isFolderCountedInBadges(resolve(row.accountId, row.folder))) continue
    total += row.unread
  }
  return total
}
