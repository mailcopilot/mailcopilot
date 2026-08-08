import { describe, expect, it } from 'vitest'
import type { FolderRoles, Mailbox, MessageEnvelope } from '@mailcopilot/types'
import {
  addrListToString,
  addrToString,
  addrTooltip,
  addrDisplayName,
  computeReplyRecipients,
  extractEmails,
  folderLabel,
  formatBytes,
  formatSmartDate,
  getAvatarColor,
  getPaletteColor,
  AVATAR_COLORS,
  getFolderRole,
  getInitials,
  normalizeCid,
  prefixSubject,
  quoteText,
  replaceCidImages,
  sortFolders,
  uniqEmails,
} from './mail'

describe('packages/core/mail (pure)', () => {
  // --- prefixSubject ---

  it('prefixSubject adds prefix and does not duplicate it', () => {
    expect(prefixSubject('Re', 'Hello')).toBe('Re: Hello')
    expect(prefixSubject('Re', 'Re: Hello')).toBe('Re: Hello')
    expect(prefixSubject('Re', '  re : Hello')).toBe('  re : Hello')
    expect(prefixSubject('Fwd', '')).toBe('Fwd:')
  })

  it('prefixSubject with empty subject', () => {
    expect(prefixSubject('Re', '')).toBe('Re:')
  })

  it('prefixSubject does not duplicate Fwd', () => {
    expect(prefixSubject('Fwd', 'Fwd: Test')).toBe('Fwd: Test')
  })

  // --- uniqEmails ---

  it('uniqEmails deduplicates case-insensitively', () => {
    expect(uniqEmails(['A@EXAMPLE.COM', 'a@example.com', 'b@example.com'])).toEqual(['A@EXAMPLE.COM', 'b@example.com'])
  })

  it('uniqEmails with empty array', () => {
    expect(uniqEmails([])).toEqual([])
  })

  // --- extractEmails ---

  it('extractEmails extracts addresses from the list', () => {
    expect(extractEmails([{ address: 'a@example.com' }, { address: ' ' }, { name: 'No address' }])).toEqual(['a@example.com'])
  })

  it('extractEmails with undefined', () => {
    expect(extractEmails(undefined)).toEqual([])
  })

  // --- formatBytes ---

  it('formatBytes formats bytes', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(-100)).toBe('')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  // --- getInitials ---

  it('getInitials extracts initials', () => {
    expect(getInitials('Alice Example <alice@example.com>')).toBe('AE')
    expect(getInitials('alice@example.com')).toBe('AL')
    expect(getInitials('')).toBe('?')
    expect(getInitials('john.doe@test.com')).toBe('JD')
    expect(getInitials('Admin')).toBe('AD')
  })

  // --- getAvatarColor ---

  it('getAvatarColor is stable', () => {
    expect(getAvatarColor('alice@example.com')).toBe(getAvatarColor('alice@example.com'))
    expect(getAvatarColor('alice@example.com')).not.toBe(getAvatarColor('bob@example.com'))
  })

  it('getAvatarColor returns a valid HEX color', () => {
    const color = getAvatarColor('test@test.com')
    expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  // --- getPaletteColor ---

  it('getPaletteColor returns a color from AVATAR_COLORS by index', () => {
    expect(getPaletteColor(0)).toBe(AVATAR_COLORS[0])
    expect(getPaletteColor(3)).toBe(AVATAR_COLORS[3])
    expect(getPaletteColor(AVATAR_COLORS.length)).toBe(AVATAR_COLORS[0])
  })

  // --- sortFolders ---

  it('sortFolders sorts INBOX and roles before others', () => {
    const folders: Mailbox[] = [
      { path: 'Z', name: 'Z' },
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Trash', name: 'Trash' },
      { path: 'A', name: 'A' },
    ]
    const roles: FolderRoles = { trash: 'Trash' }
    const sorted = sortFolders(folders, roles)
    expect(sorted.map(f => f.path)).toEqual(['INBOX', 'Trash', 'A', 'Z'])
  })

  it('sortFolders does not mutate the original array', () => {
    const folders: Mailbox[] = [
      { path: 'B', name: 'B' },
      { path: 'A', name: 'A' },
    ]
    const original = [...folders]
    sortFolders(folders, {})
    expect(folders).toEqual(original)
  })

  // --- getFolderRole / folderLabel ---

  it('getFolderRole and folderLabel work for special folders', () => {
    const t = (k: string) => k
    const role = getFolderRole('INBOX', null, {})
    expect(role).toBe('\\Inbox')
    expect(folderLabel('INBOX', role, t)).toBe('folders.inbox')
  })

  it('getFolderRole determines role by specialUse', () => {
    expect(getFolderRole('Sent', '\\Sent', {})).toBe('\\Sent')
  })

  it('getFolderRole determines role by roles mapping', () => {
    const roles: FolderRoles = { archive: 'MyArchive', junk: 'MySpam' }
    expect(getFolderRole('MyArchive', null, roles)).toBe('\\Archive')
    expect(getFolderRole('MySpam', null, roles)).toBe('\\Junk')
  })

  it('getFolderRole returns null for regular folders', () => {
    expect(getFolderRole('Custom', null, {})).toBeNull()
  })

  // --- addrToString / addrListToString ---

  it('addrToString formats an address', () => {
    expect(addrToString({ name: 'Alice', address: 'alice@test.com' })).toBe('Alice <alice@test.com>')
    expect(addrToString({ address: 'alice@test.com' })).toBe('alice@test.com')
    expect(addrToString({ name: 'Alice' })).toBe('Alice')
    expect(addrToString({})).toBe('')
  })

  it('addrListToString joins addresses', () => {
    expect(addrListToString([
      { name: 'Alice', address: 'alice@test.com' },
      { address: 'bob@test.com' },
    ])).toBe('Alice <alice@test.com>, bob@test.com')
  })

  it('addrListToString with empty/undefined list', () => {
    expect(addrListToString(undefined)).toBe('')
    expect(addrListToString([])).toBe('')
  })

  // --- quoteText ---

  it('quoteText adds > to each line', () => {
    expect(quoteText('line1\nline2\nline3')).toBe('> line1\n> line2\n> line3')
  })

  // --- cid: inline images ---

  it('normalizeCid strips <>', () => {
    expect(normalizeCid('<abc>')).toBe('abc')
    expect(normalizeCid('abc')).toBe('abc')
    expect(normalizeCid(' <a@b> ')).toBe('a@b')
  })

  it('replaceCidImages replaces cid: with data:', () => {
    const html = '<img src="cid:img1@x" /><img src="cid:<img2@x>"/>'
    const out = replaceCidImages(html, {
      'img1@x': 'data:image/png;base64,AAAA',
      '<img2@x>': 'data:image/jpeg;base64,BBBB',
    })
    expect(out).toContain('src="data:image/png;base64,AAAA"')
    expect(out).toContain('src="data:image/jpeg;base64,BBBB"')
  })

  it('replaceCidImages accepts a Map, including cids that name Object.prototype members', () => {
    const html = '<img src="cid:__proto__"><img src="cid:<constructor>">'
    const out = replaceCidImages(html, new Map([
      ['__proto__', 'data:image/png;base64,AAAA'],
      ['constructor', 'data:image/png;base64,BBBB'],
    ]))
    expect(out).toContain('src="data:image/png;base64,AAAA"')
    expect(out).toContain('src="data:image/png;base64,BBBB"')
    expect(out).not.toContain('cid:')
  })

  it('replaceCidImages reads own properties, so a prototype-less record works too', () => {
    const map: Record<string, string> = Object.create(null)
    map['__proto__'] = 'data:image/png;base64,AAAA'
    const out = replaceCidImages('<img src="cid:__proto__">', map)
    expect(out).toContain('src="data:image/png;base64,AAAA"')
  })

  // --- formatSmartDate ---

  it('formatSmartDate: today -> time', () => {
    const now = new Date()
    const t = (k: string) => k
    const result = formatSmartDate(now.toISOString(), t)
    expect(result.display).toMatch(/\d{1,2}:\d{2}/)
  })

  it('formatSmartDate: invalid date -> returns as-is', () => {
    const t = (k: string) => k
    const result = formatSmartDate('not-a-date', t)
    expect(result.display).toBe('not-a-date')
  })
})

/**
 * Tests for reply-all recipient computation (d767639). The critical
 * regression covered here: when Reply-To is present and differs from From,
 * the original sender (env.from) must still appear in the CC pool.
 * Previously this dropped the sender because CC only considered
 * env.to + env.cc.
 */
describe('computeReplyRecipients', () => {
  const envelope = (fields: Partial<MessageEnvelope>): MessageEnvelope => ({ ...fields })

  it('reply: To = From when no Reply-To, CC undefined', () => {
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'me@example.com' }],
    })
    const r = computeReplyRecipients(env, 'reply', 'me@example.com')
    expect(r.to).toBe('sender@example.com')
    expect(r.cc).toBeUndefined()
  })

  it('reply: To = Reply-To when Reply-To present, CC still undefined', () => {
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      replyTo: [{ address: 'list@example.com' }],
      to: [{ address: 'me@example.com' }],
    })
    const r = computeReplyRecipients(env, 'reply', 'me@example.com')
    expect(r.to).toBe('list@example.com')
    expect(r.cc).toBeUndefined()
  })

  it('replyAll with Reply-To != From: CC contains original sender (the regression)', () => {
    // Bug reported 2026-04-21: list@example.com was in Reply-To, but
    // sender@example.com (the actual human sender) was dropped from CC.
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      replyTo: [{ address: 'list@example.com' }],
      to: [{ address: 'me@example.com' }],
      cc: [],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@example.com')
    expect(r.to).toBe('list@example.com')
    expect(r.cc).toBe('sender@example.com')
  })

  it('replyAll with Reply-To == From: CC does not double-include sender', () => {
    // uniqEmails inside the helper must de-dupe sender@example.com appearing
    // in both env.from and env.replyTo. CC ends up empty (undefined) because
    // after filtering out `me` and the reply target, nothing remains.
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      replyTo: [{ address: 'sender@example.com' }],
      to: [{ address: 'me@example.com' }],
      cc: [],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@example.com')
    expect(r.to).toBe('sender@example.com')
    // CC is empty after de-dupe + filter — no "sender@example.com,sender@example.com".
    expect(r.cc).toBeUndefined()
  })

  it('replyAll case-insensitive dedupe: Reply-To and From differ only in case', () => {
    const env = envelope({
      from: [{ address: 'Sender@Example.com' }],
      replyTo: [{ address: 'sender@example.com' }],
      to: [{ address: 'me@example.com' }],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@example.com')
    expect(r.to).toBe('sender@example.com')
    expect(r.cc).toBeUndefined()
  })

  it('replyAll filters out the user own address from CC', () => {
    // `me` must never appear in CC, even when it shows up in original To.
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      replyTo: [{ address: 'list@example.com' }],
      to: [{ address: 'me@example.com' }, { address: 'friend@example.com' }],
      cc: [{ address: 'other@example.com' }],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@example.com')
    expect(r.to).toBe('list@example.com')
    // sender@example.com must appear (regression); me@ must NOT.
    expect(r.cc).toBe('sender@example.com, friend@example.com, other@example.com')
    expect(r.cc).not.toContain('me@example.com')
  })

  it('replyAll filters the user address case-insensitively', () => {
    // me is supplied lowercased by the caller, but env.to may contain it with
    // different casing (users type inconsistently). The filter inside the
    // helper lowercases each candidate before comparing, so ME@Example.com
    // must be removed. With no Reply-To the reply target is env.from
    // (sender@), which is also filtered from CC — leaving just friend@.
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'ME@Example.com' }, { address: 'friend@example.com' }],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@example.com')
    expect(r.cc).toBe('friend@example.com')
    expect((r.cc ?? '').toLowerCase()).not.toContain('me@example.com')
  })

  it('replyAll with empty envelope returns empty to and undefined cc', () => {
    const r = computeReplyRecipients(undefined, 'replyAll', 'me@example.com')
    expect(r.to).toBe('')
    expect(r.cc).toBeUndefined()
    expect(r.originalRecipients).toEqual([])
  })

  it('originalRecipients contains from + to + cc de-duped (for GTD heuristics)', () => {
    // originalRecipients feeds downstream behavior (e.g. GTD
    // misdirection) — it must always reflect the original audience of the
    // message regardless of mode.
    const env = envelope({
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'me@example.com' }, { address: 'sender@example.com' }],
      cc: [{ address: 'friend@example.com' }],
    })
    const r = computeReplyRecipients(env, 'reply', 'me@example.com')
    expect(r.originalRecipients).toEqual(['sender@example.com', 'me@example.com', 'friend@example.com'])
  })

  it('replyAll preserves sender even with mailing-list alias in Reply-To', () => {
    // Real-world scenario: mailing list rewrites Reply-To to list@. Without
    // the fix, sender@ would be dropped because it is not in env.to / env.cc.
    const env = envelope({
      from: [{ name: 'Alice', address: 'alice@company.com' }],
      replyTo: [{ address: 'announce@lists.example.org' }],
      to: [{ address: 'announce@lists.example.org' }],
    })
    const r = computeReplyRecipients(env, 'replyAll', 'me@company.com')
    expect(r.to).toBe('announce@lists.example.org')
    // announce@ is the reply target (To), so filtered from CC. alice@ must
    // remain — she is the human on the other end of the conversation.
    expect(r.cc).toBe('alice@company.com')
  })
})

// §3.3.C-uiaudit.22 — addrTooltip / addrDisplayName

describe('addrTooltip', () => {
  it('returns "Name <email>" when both present', () => {
    expect(addrTooltip({ name: 'Alice', address: 'alice@example.com' }))
      .toBe('Alice <alice@example.com>')
  })

  it('returns email only when name is absent', () => {
    expect(addrTooltip({ address: 'alice@example.com' })).toBe('alice@example.com')
  })

  it('returns name only when address is absent', () => {
    expect(addrTooltip({ name: 'Alice' })).toBe('Alice')
  })

  it('returns empty string for an empty address object', () => {
    expect(addrTooltip({})).toBe('')
  })
})

describe('addrDisplayName', () => {
  it('returns name when both name and address are present', () => {
    expect(addrDisplayName({ name: 'Alice Smith', address: 'alice@example.com' }))
      .toBe('Alice Smith')
  })

  it('returns address when name is absent', () => {
    expect(addrDisplayName({ address: 'alice@example.com' })).toBe('alice@example.com')
  })

  it('returns name when address is absent', () => {
    expect(addrDisplayName({ name: 'Alice' })).toBe('Alice')
  })

  it('returns empty string for an empty address object', () => {
    expect(addrDisplayName({})).toBe('')
  })

  it('trims whitespace from name', () => {
    expect(addrDisplayName({ name: '  Alice  ', address: 'a@b.com' })).toBe('Alice')
  })
})

// §3.3.C-uiaudit.22 — addrListToString backward compatibility
// addrListToString must continue to work exactly as before for all callers
// (compose prefill, misdirection, reply header templates) after addrTooltip /
// addrDisplayName were added alongside it.

describe('addrListToString backward compatibility', () => {
  it('formats a mixed list of named and unnamed addresses', () => {
    expect(addrListToString([
      { name: 'Alice', address: 'alice@example.com' },
      { address: 'bob@example.com' },
      { name: 'Carol', address: 'carol@example.com' },
    ])).toBe('Alice <alice@example.com>, bob@example.com, Carol <carol@example.com>')
  })

  it('returns empty string for undefined input', () => {
    expect(addrListToString(undefined)).toBe('')
  })

  it('returns empty string for empty array', () => {
    expect(addrListToString([])).toBe('')
  })

  it('skips entries that produce empty strings', () => {
    // An object with no name and no address is filtered out by the Boolean filter.
    expect(addrListToString([{}, { address: 'a@b.com' }])).toBe('a@b.com')
  })

  it('handles a single entry with both name and address', () => {
    expect(addrListToString([{ name: 'Zoe', address: 'zoe@example.com' }]))
      .toBe('Zoe <zoe@example.com>')
  })

  it('handles name-only entries (no address)', () => {
    expect(addrListToString([{ name: 'Group Alias' }])).toBe('Group Alias')
  })

  it('is consistent with individual addrToString calls', () => {
    const list = [
      { name: 'X', address: 'x@x.com' },
      { address: 'y@y.com' },
    ]
    const viaListFn = addrListToString(list)
    const viaManual = list.map(addrToString).filter(Boolean).join(', ')
    expect(viaListFn).toBe(viaManual)
  })
})
