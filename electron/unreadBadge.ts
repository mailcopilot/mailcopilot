/**
 * §2.99 — pure math behind the unread surfaces (tray tooltip, dock/taskbar
 * badge). No electron import on purpose: everything here is decidable from
 * plain data, so it is unit-tested without a display server, and the service
 * that owns the OS calls (electron/services/tray.ts) stays a thin shell.
 */

/** Cached folder roles for one account — the subset this module reasons about. */
export type FolderRoleMap = {
  trash?: string
  junk?: string
  archive?: string
  drafts?: string
}

/**
 * Which folders of one account the LEGACY `hiddenUnreadFolders` setting keeps
 * out of new-mail notifications.
 *
 * NOT the badge policy — that is `isFolderCountedInBadges` in packages/core,
 * shared with the renderer (review H2). This list is a further, notification-
 * only narrowing: an explicit list wins, an empty list means the standard noise
 * folders.
 */
export function hiddenUnreadPathsFor(
  hiddenUnreadFolders: string[] | undefined,
  roles: FolderRoleMap | null | undefined,
): Set<string> {
  const explicit = (hiddenUnreadFolders ?? []).filter(p => typeof p === 'string' && p.length > 0)
  if (explicit.length > 0) return new Set(explicit)
  const set = new Set<string>()
  for (const path of [roles?.trash, roles?.junk, roles?.archive, roles?.drafts]) {
    if (typeof path === 'string' && path.length > 0) set.add(path)
  }
  return set
}

/**
 * Cap for the number rendered in text surfaces. The tooltip is a fixed-width
 * OS widget on Windows (64 chars on some shells) and a five-digit unread count
 * is not information anybody acts on.
 */
export const BADGE_TEXT_CAP = 999

/** `"7"`, or `"999+"` above the cap. Empty string for zero — callers clear instead. */
export function formatBadgeText(total: number): string {
  const n = Math.max(0, Math.trunc(Number.isFinite(total) ? total : 0))
  if (n === 0) return ''
  return n > BADGE_TEXT_CAP ? `${BADGE_TEXT_CAP}+` : String(n)
}

/**
 * Tray tooltip text. `template` is the localized "{{count}} unread" string;
 * `appName` alone is used when nothing is unread, so the tooltip never becomes
 * a stale "0 unread" that outlives the count that produced it.
 */
export function formatTrayTooltip(appName: string, total: number, template: string): string {
  const text = formatBadgeText(total)
  if (!text) return appName
  return `${appName} — ${template.replace('{{count}}', text)}`
}

/** Side length (px) of the taskbar overlay badge produced below. */
export const OVERLAY_ICON_SIZE = 16

/**
 * Raw BGRA bitmap of a filled dot, for `nativeImage.createFromBitmap` →
 * `BrowserWindow.setOverlayIcon` (Windows only).
 *
 * A DOT, not a number: main has no text rasteriser, and pulling one in to draw
 * two digits onto a 16px square would be a dependency bought for a surface
 * whose exact value already lives in the tray tooltip one hover away. The dot
 * answers the question the taskbar is actually asked — "is there anything new".
 */
export function renderBadgeDotBitmap(
  size = OVERLAY_ICON_SIZE,
  color: { r: number; g: number; b: number } = { r: 220, g: 38, b: 38 },
): Buffer {
  const side = Math.max(1, Math.trunc(size))
  const buf = Buffer.alloc(side * side * 4)
  const center = (side - 1) / 2
  const radius = side / 2 - 0.5
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = x - center
      const dy = y - center
      const inside = dx * dx + dy * dy <= radius * radius
      const i = (y * side + x) * 4
      // BGRA order — what nativeImage.createFromBitmap consumes.
      buf[i] = inside ? color.b : 0
      buf[i + 1] = inside ? color.g : 0
      buf[i + 2] = inside ? color.r : 0
      buf[i + 3] = inside ? 255 : 0
    }
  }
  return buf
}
