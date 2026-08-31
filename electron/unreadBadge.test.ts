import { describe, it, expect } from 'vitest'
import {
  hiddenUnreadPathsFor,
  formatBadgeText,
  formatTrayTooltip,
  renderBadgeDotBitmap,
  BADGE_TEXT_CAP,
  OVERLAY_ICON_SIZE,
} from './unreadBadge'

describe('hiddenUnreadPathsFor', () => {
  it('uses the explicit list when the user configured one', () => {
    const set = hiddenUnreadPathsFor(['Archive', 'Newsletters'], { trash: 'Trash', junk: 'Spam' })
    expect([...set].sort()).toEqual(['Archive', 'Newsletters'])
  })

  it('falls back to the standard noise folders when the list is empty', () => {
    const set = hiddenUnreadPathsFor([], { trash: 'Trash', junk: 'Spam', archive: 'Archive', drafts: 'Drafts' })
    expect([...set].sort()).toEqual(['Archive', 'Drafts', 'Spam', 'Trash'])
  })

  it('tolerates missing roles and non-string entries', () => {
    expect(hiddenUnreadPathsFor(undefined, null).size).toBe(0)
    expect(hiddenUnreadPathsFor(['', 'Real'], null)).toEqual(new Set(['Real']))
  })
})

describe('formatBadgeText / formatTrayTooltip', () => {
  it('renders plain counts and caps large ones', () => {
    expect(formatBadgeText(0)).toBe('')
    expect(formatBadgeText(7)).toBe('7')
    expect(formatBadgeText(BADGE_TEXT_CAP)).toBe('999')
    expect(formatBadgeText(BADGE_TEXT_CAP + 1)).toBe('999+')
    expect(formatBadgeText(Number.NaN)).toBe('')
  })

  it('drops the count from the tooltip when nothing is unread', () => {
    expect(formatTrayTooltip('MailCopilot', 0, '{{count}} unread')).toBe('MailCopilot')
    expect(formatTrayTooltip('MailCopilot', 4, '{{count}} unread')).toBe('MailCopilot — 4 unread')
    expect(formatTrayTooltip('MailCopilot', 5000, '{{count}} unread')).toBe('MailCopilot — 999+ unread')
  })
})

describe('renderBadgeDotBitmap', () => {
  it('produces a BGRA buffer of the requested size', () => {
    const buf = renderBadgeDotBitmap()
    expect(buf.length).toBe(OVERLAY_ICON_SIZE * OVERLAY_ICON_SIZE * 4)
  })

  it('fills the centre and leaves the corners transparent', () => {
    const side = 16
    const buf = renderBadgeDotBitmap(side, { r: 1, g: 2, b: 3 })
    const at = (x: number, y: number) => (y * side + x) * 4
    const centre = at(8, 8)
    expect(buf[centre]).toBe(3)
    expect(buf[centre + 1]).toBe(2)
    expect(buf[centre + 2]).toBe(1)
    expect(buf[centre + 3]).toBe(255)
    expect(buf[at(0, 0) + 3]).toBe(0)
    expect(buf[at(side - 1, side - 1) + 3]).toBe(0)
  })
})
