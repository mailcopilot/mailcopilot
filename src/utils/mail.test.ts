// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { FolderRoles, Mailbox } from '../../packages/net/types'
import { deriveIsSentByMe } from './mail'

// Real DOMPurify + real DOM (jsdom). The external-image hardening path
// parses HTML via DOMParser after DOMPurify sanitization; both require a
// live DOM to exercise the invariants against adversarial inputs
// (entity-encoded schemes, unquoted attributes, protocol-relative URLs,
// resource-bearing tags like <image>/<body background>).

import {
  addrListToString,
  addrToString,
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
  BLOCKED_IMAGE_PLACEHOLDER_DATA_URI,
  MAX_EXTERNAL_IMAGE_URLS,
  hasExternalImagesInHtml,
  extractExternalImageUrls,
  replaceExternalImages,
  buildExternalImageReplacementMap,
  buildMailIframeSrcDoc,
  extractCidsFromHtml,
  sanitizeMailHtml,
} from './mail'

// --- deriveIsSentByMe (§3.3.C-uiaudit.22 BCC privacy invariant) ---

describe('deriveIsSentByMe', () => {
  const SENT = 'Sent'
  const IDENTITIES = ['alice@example.com', 'alice@work.example.com']

  // Happy path: folder match + identity match → true
  it('returns true when folder is Sent and From matches a known identity', () => {
    expect(deriveIsSentByMe(
      SENT,
      { sent: SENT },
      [{ name: 'Alice', address: 'alice@example.com' }],
      IDENTITIES,
    )).toBe(true)
  })

  // Identity match is case-insensitive (both sides are lowercased)
  it('returns true with mixed-case From address', () => {
    expect(deriveIsSentByMe(
      SENT,
      { sent: SENT },
      [{ address: 'Alice@EXAMPLE.COM' }],
      IDENTITIES,
    )).toBe(true)
  })

  // Cross-account scoping: message in "Sent" folder but activeRoles.sent refers
  // to a DIFFERENT account's Sent folder path → no match
  it('returns false when folder does not match activeRoles.sent', () => {
    expect(deriveIsSentByMe(
      'INBOX',
      { sent: SENT },
      [{ address: 'alice@example.com' }],
      IDENTITIES,
    )).toBe(false)
  })

  // Spoofed mail: message IS in Sent folder but From is not a known identity
  it('returns false when From address is not in accountIdentities (spoofed sender)', () => {
    expect(deriveIsSentByMe(
      SENT,
      { sent: SENT },
      [{ address: 'attacker@evil.test' }],
      IDENTITIES,
    )).toBe(false)
  })

  // Safe defaults: null/undefined inputs
  it('returns false when activeFolder is null', () => {
    expect(deriveIsSentByMe(null, { sent: SENT }, [{ address: 'alice@example.com' }], IDENTITIES)).toBe(false)
  })

  it('returns false when activeFolder is undefined', () => {
    expect(deriveIsSentByMe(undefined, { sent: SENT }, [{ address: 'alice@example.com' }], IDENTITIES)).toBe(false)
  })

  it('returns false when activeRoles is null', () => {
    expect(deriveIsSentByMe(SENT, null, [{ address: 'alice@example.com' }], IDENTITIES)).toBe(false)
  })

  it('returns false when activeRoles has no sent key', () => {
    expect(deriveIsSentByMe(SENT, {}, [{ address: 'alice@example.com' }], IDENTITIES)).toBe(false)
  })

  it('returns false when envFrom is empty array', () => {
    expect(deriveIsSentByMe(SENT, { sent: SENT }, [], IDENTITIES)).toBe(false)
  })

  it('returns false when envFrom is null', () => {
    expect(deriveIsSentByMe(SENT, { sent: SENT }, null, IDENTITIES)).toBe(false)
  })

  it('returns false when accountIdentities is empty (no known identities)', () => {
    expect(deriveIsSentByMe(SENT, { sent: SENT }, [{ address: 'alice@example.com' }], [])).toBe(false)
  })

  // Edge: From address has no `address` field (just name)
  it('returns false when all From entries have no address field', () => {
    expect(deriveIsSentByMe(SENT, { sent: SENT }, [{ name: 'Alice' }], IDENTITIES)).toBe(false)
  })

  // Multiple From addresses — one of them is a known identity
  it('returns true when one of multiple From addresses matches', () => {
    expect(deriveIsSentByMe(
      SENT,
      { sent: SENT },
      [{ address: 'nobody@other.test' }, { address: 'alice@work.example.com' }],
      IDENTITIES,
    )).toBe(true)
  })

  // Identity trimming — extra whitespace in address should be normalized
  it('returns true when From address has leading/trailing whitespace', () => {
    expect(deriveIsSentByMe(
      SENT,
      { sent: SENT },
      [{ address: '  alice@example.com  ' }],
      IDENTITIES,
    )).toBe(true)
  })
})

describe('src/utils/mail (pure)', () => {
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

  it('uniqEmails with single element', () => {
    expect(uniqEmails(['test@test.com'])).toEqual(['test@test.com'])
  })

  // --- extractEmails ---

  it('extractEmails extracts addresses from the list', () => {
    expect(extractEmails([{ address: 'a@example.com' }, { address: ' ' }, { name: 'No address' }])).toEqual(['a@example.com'])
  })

  it('extractEmails with undefined', () => {
    expect(extractEmails(undefined)).toEqual([])
  })

  it('extractEmails with empty array', () => {
    expect(extractEmails([])).toEqual([])
  })

  // --- formatBytes ---

  it('formatBytes formats bytes', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('formatBytes for GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('formatBytes for negative values', () => {
    expect(formatBytes(-100)).toBe('')
  })

  it('formatBytes for fractional values', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  // --- getInitials ---

  it('getInitials extracts initials', () => {
    expect(getInitials('Alice Example <alice@example.com>')).toBe('AE')
    expect(getInitials('alice@example.com')).toBe('AL')
    expect(getInitials('')).toBe('?')
  })

  it('getInitials from name with separators', () => {
    expect(getInitials('john.doe@test.com')).toBe('JD')
    expect(getInitials('john_doe@test.com')).toBe('JD')
    expect(getInitials('john-doe@test.com')).toBe('JD')
  })

  it('getInitials from a single name', () => {
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
  })

  it('getPaletteColor wraps index when out of bounds', () => {
    expect(getPaletteColor(AVATAR_COLORS.length)).toBe(AVATAR_COLORS[0])
    expect(getPaletteColor(AVATAR_COLORS.length + 2)).toBe(AVATAR_COLORS[2])
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

  it('sortFolders: all roles in correct order', () => {
    const folders: Mailbox[] = [
      { path: 'Junk', name: 'Junk' },
      { path: 'Drafts', name: 'Drafts' },
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Archive', name: 'Archive' },
      { path: 'Sent', name: 'Sent' },
      { path: 'Trash', name: 'Trash' },
      { path: 'Custom', name: 'Custom' },
    ]
    const roles: FolderRoles = {
      sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', junk: 'Junk',
    }
    const sorted = sortFolders(folders, roles)
    // INBOX → sent → drafts → archive → trash → junk → custom
    expect(sorted.map(f => f.path)).toEqual(['INBOX', 'Sent', 'Drafts', 'Archive', 'Trash', 'Junk', 'Custom'])
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
    expect(getFolderRole('Trash', '\\Trash', {})).toBe('\\Trash')
    expect(getFolderRole('Drafts', '\\Drafts', {})).toBe('\\Drafts')
  })

  it('getFolderRole determines role by roles mapping', () => {
    const roles: FolderRoles = { archive: 'MyArchive', junk: 'MySpam' }
    expect(getFolderRole('MyArchive', null, roles)).toBe('\\Archive')
    expect(getFolderRole('MySpam', null, roles)).toBe('\\Junk')
  })

  it('getFolderRole returns null for regular folders', () => {
    expect(getFolderRole('Custom', null, {})).toBeNull()
  })

  it('folderLabel for all roles', () => {
    const t = (k: string) => k
    expect(folderLabel('Sent', '\\Sent', t)).toBe('folders.sent')
    expect(folderLabel('Drafts', '\\Drafts', t)).toBe('folders.drafts')
    expect(folderLabel('Trash', '\\Trash', t)).toBe('folders.trash')
    expect(folderLabel('Junk', '\\Junk', t)).toBe('folders.junk')
    expect(folderLabel('Archive', '\\Archive', t)).toBe('folders.archive')
  })

  it('folderLabel for a regular folder returns the name', () => {
    const t = (k: string) => k
    expect(folderLabel('My Custom', null, t)).toBe('My Custom')
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

  it('quoteText with empty string', () => {
    expect(quoteText('')).toBe('> ')
  })

  it('quoteText with a single line', () => {
    expect(quoteText('hello')).toBe('> hello')
  })

  // --- formatSmartDate ---

  it('formatSmartDate: today -> time', () => {
    const now = new Date()
    const isoDate = now.toISOString()
    const t = (k: string) => k
    const result = formatSmartDate(isoDate, t)
    expect(result.display).toMatch(/\d{1,2}:\d{2}/)
  })

  it('formatSmartDate: yesterday -> "Yesterday"', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const t = (k: string) => k === 'mail.date.yesterday' ? 'Вчера' : k
    const result = formatSmartDate(yesterday.toISOString(), t)
    expect(result.display).toBe('Вчера')
  })

  it('formatSmartDate: invalid date -> returns as-is', () => {
    const t = (k: string) => k
    const result = formatSmartDate('not-a-date', t)
    expect(result.display).toBe('not-a-date')
    expect(result.full).toBe('not-a-date')
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

  it('formatSmartDate: previous year -> date with year', () => {
    const old = new Date('2020-06-15T12:00:00Z')
    const t = (k: string) => k
    const result = formatSmartDate(old.toISOString(), t)
    expect(result.display).toBeTruthy()
    expect(result.full).toBeTruthy()
  })
})

describe('external image hardening', () => {
  // --- BLOCKED_IMAGE_PLACEHOLDER_DATA_URI ---

  it('placeholder is an inline data: URI and never a remote URL', () => {
    expect(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI).toMatch(/^data:image\/svg\+xml/i)
    expect(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI).not.toMatch(/^https?:/)
  })

  // --- hasExternalImagesInHtml ---

  it('hasExternalImagesInHtml detects <img src=https://...>', () => {
    expect(hasExternalImagesInHtml('<img src="https://example.com/x.png">')).toBe(true)
    expect(hasExternalImagesInHtml('<img src="http://example.com/x.png">')).toBe(true)
  })

  it('hasExternalImagesInHtml detects protocol-relative src', () => {
    expect(hasExternalImagesInHtml('<img src="//cdn.example.com/x.png">')).toBe(true)
  })

  it('hasExternalImagesInHtml detects <input type=image>', () => {
    expect(hasExternalImagesInHtml('<input type="image" src="https://tracker.example/pixel.gif">')).toBe(true)
  })

  it('hasExternalImagesInHtml detects CSS url()', () => {
    expect(hasExternalImagesInHtml('<div style="background-image:url(https://example.com/bg.png)">x</div>')).toBe(true)
  })

  it('hasExternalImagesInHtml ignores cid: and data:', () => {
    expect(hasExternalImagesInHtml('<img src="cid:foo">')).toBe(false)
    expect(hasExternalImagesInHtml('<img src="data:image/png;base64,AAA">')).toBe(false)
  })

  it('hasExternalImagesInHtml handles empty input', () => {
    expect(hasExternalImagesInHtml('')).toBe(false)
  })

  // --- extractExternalImageUrls ---

  it('extractExternalImageUrls extracts <img src>', () => {
    const html = '<img src="https://a.test/1.png"><img src="http://b.test/2.jpg">'
    expect(extractExternalImageUrls(html)).toEqual([
      'https://a.test/1.png',
      'http://b.test/2.jpg',
    ])
  })

  it('extractExternalImageUrls normalizes protocol-relative //host/...', () => {
    const html = '<img src="//cdn.test/x.png">'
    expect(extractExternalImageUrls(html)).toEqual(['https://cdn.test/x.png'])
  })

  it('extractExternalImageUrls extracts srcset URLs (all descriptors)', () => {
    const html = '<img srcset="https://a.test/1x.png 1x, https://a.test/2x.png 2x, //b.test/3x.png 3x">'
    const urls = extractExternalImageUrls(html)
    expect(urls).toContain('https://a.test/1x.png')
    expect(urls).toContain('https://a.test/2x.png')
    expect(urls).toContain('https://b.test/3x.png')
  })

  it('extractExternalImageUrls covers <input type="image"> (both attribute orders)', () => {
    const html1 = '<input type="image" src="https://tracker.test/pixel.gif" alt="x">'
    expect(extractExternalImageUrls(html1)).toContain('https://tracker.test/pixel.gif')

    const html2 = '<input src="https://tracker.test/pixel2.gif" type="image" alt="y">'
    expect(extractExternalImageUrls(html2)).toContain('https://tracker.test/pixel2.gif')
  })

  it('extractExternalImageUrls covers CSS url() in various properties', () => {
    const html = [
      '<div style="background-image:url(https://a.test/bg.png)">x</div>',
      '<div style="content:url(https://b.test/c.png)">y</div>',
      '<style>.z{border-image:url(https://c.test/br.png)}</style>',
    ].join('')
    const urls = extractExternalImageUrls(html)
    expect(urls).toContain('https://a.test/bg.png')
    expect(urls).toContain('https://b.test/c.png')
    expect(urls).toContain('https://c.test/br.png')
  })

  it('extractExternalImageUrls skips cid: and data:', () => {
    const html = '<img src="cid:foo"><img src="data:image/png;base64,AAA">'
    expect(extractExternalImageUrls(html)).toEqual([])
  })

  it('extractExternalImageUrls deduplicates identical URLs', () => {
    const html = '<img src="https://x.test/a.png"><img src="https://x.test/a.png">'
    expect(extractExternalImageUrls(html)).toEqual(['https://x.test/a.png'])
  })

  it('extractExternalImageUrls does NOT cap extraction — cap is a fetch-budget concept, not a replacement-coverage one', () => {
    // wave-3 §3.10 P0 fix: the old extractor capped at MAX_EXTERNAL_IMAGE_URLS,
    // which left URLs past the cap raw in the rendered DOM. New contract:
    // extraction returns every URL; the budget is applied by the caller when
    // deciding how many to fetch via the main-process proxy. URLs past the
    // budget still flow through buildExternalImageReplacementMap →
    // replaceExternalImages → placeholder.
    const n = MAX_EXTERNAL_IMAGE_URLS + 50 // > budget
    const parts: string[] = []
    for (let i = 0; i < n; i++) parts.push(`<img src="https://host.test/${i}.png">`)
    const urls = extractExternalImageUrls(parts.join(''))
    expect(urls.length).toBe(n)
  })

  it('extractExternalImageUrls handles empty and malformed input', () => {
    expect(extractExternalImageUrls('')).toEqual([])
    expect(extractExternalImageUrls('<img>')).toEqual([])
    expect(extractExternalImageUrls('<div>no images here</div>')).toEqual([])
  })

  // --- replaceExternalImages ---

  it('replaceExternalImages substitutes URLs in src attribute', () => {
    const html = '<img src="https://a.test/x.png">'
    const out = replaceExternalImages(html, { 'https://a.test/x.png': 'data:image/png;base64,AAA' })
    expect(out).toContain('src="data:image/png;base64,AAA"')
    expect(out).not.toContain('https://a.test/x.png')
  })

  it('replaceExternalImages substitutes URLs in srcset', () => {
    const html = '<img srcset="https://a.test/x.png 1x, https://a.test/x2.png 2x">'
    const out = replaceExternalImages(html, {
      'https://a.test/x.png': 'data:image/png;base64,AAA',
      'https://a.test/x2.png': 'data:image/png;base64,BBB',
    })
    expect(out).not.toContain('https://a.test/x.png')
    expect(out).not.toContain('https://a.test/x2.png')
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('data:image/png;base64,BBB')
  })

  it('replaceExternalImages substitutes URLs in CSS url()', () => {
    const html = '<div style="background-image:url(https://a.test/bg.png)">x</div>'
    const out = replaceExternalImages(html, { 'https://a.test/bg.png': 'data:image/png;base64,ZZZ' })
    expect(out).toContain('data:image/png;base64,ZZZ')
    expect(out).not.toContain('https://a.test/bg.png')
  })

  it('replaceExternalImages replaces with placeholder when mapped value is placeholder', () => {
    const html = '<img src="https://tracker.test/pixel.gif">'
    const out = replaceExternalImages(html, {
      'https://tracker.test/pixel.gif': BLOCKED_IMAGE_PLACEHOLDER_DATA_URI,
    })
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
    expect(out).not.toContain('https://tracker.test/pixel.gif')
  })

  it('replaceExternalImages case-insensitively matches URLs', () => {
    const html = '<img src="HTTPS://Example.Com/X.PNG">'
    const out = replaceExternalImages(html, { 'https://example.com/x.png': 'data:image/png;base64,Q' })
    expect(out).toContain('data:image/png;base64,Q')
  })

  it('replaceExternalImages is a noop for empty map', () => {
    const html = '<img src="https://a.test/x.png">'
    expect(replaceExternalImages(html, {})).toBe(html)
  })

  it('replaceExternalImages does not touch text outside attributes', () => {
    const html = '<p>Visit https://a.test/x.png for more.</p><img src="https://a.test/x.png">'
    const out = replaceExternalImages(html, { 'https://a.test/x.png': 'data:image/png;base64,A' })
    // Attribute replaced.
    expect(out).toContain('src="data:image/png;base64,A"')
    // Plain-text URL in <p> is preserved (no attribute prefix).
    expect(out).toContain('<p>Visit https://a.test/x.png for more.</p>')
  })

  // --- buildExternalImageReplacementMap ---

  it('buildExternalImageReplacementMap prefers inlined data URI, falls back to placeholder', () => {
    const extracted = ['https://a.test/ok.png', 'https://b.test/failed.png']
    const inlined = { 'https://a.test/ok.png': 'data:image/png;base64,OK' }
    const map = buildExternalImageReplacementMap(extracted, inlined)
    expect(map['https://a.test/ok.png']).toBe('data:image/png;base64,OK')
    expect(map['https://b.test/failed.png']).toBe(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('buildExternalImageReplacementMap returns an empty map for no URLs', () => {
    expect(buildExternalImageReplacementMap([], {})).toEqual({})
  })

  it('buildExternalImageReplacementMap never leaves any URL unmapped', () => {
    const extracted = ['https://a.test/1.png', 'https://a.test/2.png', 'https://a.test/3.png']
    const map = buildExternalImageReplacementMap(extracted, {})
    for (const url of extracted) {
      expect(map[url]).toBe(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
    }
  })

  // --- buildMailIframeSrcDoc (CSP invariant) ---

  it('buildMailIframeSrcDoc CSP is ALWAYS img-src self/data/cid — never http/https', () => {
    const lightDoc = buildMailIframeSrcDoc('<p>hi</p>', { darkMode: false })
    const darkDoc = buildMailIframeSrcDoc('<p>hi</p>', { darkMode: true })

    for (const doc of [lightDoc, darkDoc]) {
      expect(doc).toContain("img-src 'self' data: cid:")
      // Hard invariant: http:/https: must never appear in CSP img-src directive.
      expect(doc).not.toMatch(/img-src[^;"]*\bhttps?:/)
      // And default-src stays 'none'.
      expect(doc).toContain("default-src 'none'")
      // connect-src blocks any renderer-originated network activity.
      expect(doc).toContain("connect-src 'none'")
      // script-src 'none' kills any injected script tags.
      expect(doc).toContain("script-src 'none'")
      // Referrer policy hard-set to no-referrer.
      expect(doc).toContain('name="referrer" content="no-referrer"')
    }
  })

  it('buildMailIframeSrcDoc embeds body HTML verbatim between <body> tags', () => {
    const doc = buildMailIframeSrcDoc('<p>hello</p>', { darkMode: false })
    expect(doc).toContain('<body>')
    expect(doc).toContain('<p>hello</p>')
    expect(doc).toContain('</body>')
  })

  it('buildMailIframeSrcDoc dark mode adds invert filter', () => {
    const doc = buildMailIframeSrcDoc('<p>x</p>', { darkMode: true })
    expect(doc).toContain('filter:invert(1)')
  })

  // --- extractCidsFromHtml ---

  it('extractCidsFromHtml extracts cid references', () => {
    const html = '<img src="cid:abc@x"><img src="cid:<def@y>">'
    const cids = extractCidsFromHtml(html)
    expect(cids).toContain('abc@x')
    expect(cids).toContain('def@y')
  })

  it('extractCidsFromHtml returns unique cids', () => {
    const html = '<img src="cid:dup@x"><img src="cid:dup@x">'
    expect(extractCidsFromHtml(html)).toEqual(['dup@x'])
  })

  it('extractCidsFromHtml handles empty input', () => {
    expect(extractCidsFromHtml('')).toEqual([])
  })

  // --- Composite pipeline: extract → buildMap → replace ----------------------
  //
  // The hard invariant that drives §3.10 P0 lives in App.tsx: after running
  // the full pipeline on sanitized HTML, NO raw http(s) URL may remain in any
  // image-related DOM position. These tests exercise the composition end-to-end
  // to guarantee that changing one step in isolation (e.g. loosening extractor
  // but not updating replacer) cannot silently leave raw URLs in the final HTML.

  it('pipeline: failed fetch (empty inlined map) replaces every extracted URL with placeholder', () => {
    const html = [
      '<img src="https://fail1.test/a.png">',
      '<img srcset="https://fail2.test/1.png 1x, https://fail3.test/2.png 2x">',
      '<div style="background-image:url(https://fail4.test/bg.png)"></div>',
      '<input type="image" src="https://fail5.test/pixel.gif">',
    ].join('')

    const extracted = extractExternalImageUrls(html)
    expect(extracted.length).toBeGreaterThanOrEqual(5)

    // Simulate the "all fetches failed" case — main process returned !ok for each.
    const inlined: Record<string, string> = {}
    const map = buildExternalImageReplacementMap(extracted, inlined)
    const out = replaceExternalImages(html, map)

    // Every raw external URL is gone from image-related positions.
    expect(out).not.toMatch(/src=['"]https?:\/\/fail\d\.test/)
    expect(out).not.toMatch(/url\(\s*['"]?https?:\/\/fail\d\.test/)
    // The srcset attribute no longer carries ANY raw URL.
    const srcsetMatch = out.match(/srcset\s*=\s*['"]([^'"]*)['"]/i)
    expect(srcsetMatch?.[1] || '').not.toMatch(/https?:\/\//)
    // Placeholder appears at least once (at minimum for the failure path).
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('pipeline: partial fetch success — successes inlined, failures get placeholder', () => {
    const html = [
      '<img src="https://ok.test/a.png">',
      '<img src="https://fail.test/b.png">',
    ].join('')
    const extracted = extractExternalImageUrls(html)
    const inlined = { 'https://ok.test/a.png': 'data:image/png;base64,OK' }
    const map = buildExternalImageReplacementMap(extracted, inlined)
    const out = replaceExternalImages(html, map)

    expect(out).toContain('data:image/png;base64,OK')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
    expect(out).not.toContain('https://ok.test/a.png')
    expect(out).not.toContain('https://fail.test/b.png')
  })

  it('pipeline: mixed image positions in a single HTML chunk are all rewritten', () => {
    // Single fragment mixing every supported extractor path.
    const html = [
      '<img src="https://m.test/1.png">',
      '<img srcset="https://m.test/s1.png 1x, https://m.test/s2.png 2x, https://m.test/s3.png 3x">',
      '<picture><source srcset="https://m.test/src1.png 1x, https://m.test/src2.png 2x"></picture>',
      '<input type="image" src="https://m.test/beacon.gif">',
      '<div style="background-image:url(https://m.test/bg.png); content:url(https://m.test/content.png)"></div>',
    ].join('')

    const extracted = extractExternalImageUrls(html)
    // Every URL must have a placeholder mapping even with no inlined.
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)

    // No raw external URL survives in attributes or url(...).
    expect(out).not.toMatch(/src=['"]https?:\/\/m\.test/)
    expect(out).not.toMatch(/srcset=['"][^'"]*https?:\/\/m\.test/i)
    expect(out).not.toMatch(/url\(\s*['"]?https?:\/\/m\.test/)
  })

  // --- srcset two-pass replacer: ≥3 URLs + first/middle/last positions -------

  it('replaceExternalImages rewrites every URL in a srcset with 3+ descriptors', () => {
    const html = '<img srcset="https://a.test/1.png 1x, https://a.test/2.png 2x, https://a.test/3.png 3x">'
    const map = {
      'https://a.test/1.png': 'data:image/png;base64,AAA',
      'https://a.test/2.png': 'data:image/png;base64,BBB',
      'https://a.test/3.png': 'data:image/png;base64,CCC',
    }
    const out = replaceExternalImages(html, map)
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).toContain('data:image/png;base64,BBB')
    expect(out).toContain('data:image/png;base64,CCC')
    expect(out).not.toContain('https://a.test/1.png')
    expect(out).not.toContain('https://a.test/2.png')
    expect(out).not.toContain('https://a.test/3.png')
  })

  it('replaceExternalImages in <source srcset> inside <picture> also rewrites every URL', () => {
    const html = '<picture><source srcset="https://p.test/1.webp 1x, https://p.test/2.webp 2x, https://p.test/3.webp 3x"><img src="https://p.test/fallback.png"></picture>'
    const extracted = extractExternalImageUrls(html)
    // Extractor should find the <source srcset> entries + the <img src> fallback.
    expect(extracted).toContain('https://p.test/1.webp')
    expect(extracted).toContain('https://p.test/2.webp')
    expect(extracted).toContain('https://p.test/3.webp')
    expect(extracted).toContain('https://p.test/fallback.png')

    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    // The entire <source srcset="..."> attribute must not carry any raw URL.
    const srcsetAttr = out.match(/srcset\s*=\s*['"]([^'"]*)['"]/i)
    expect(srcsetAttr?.[1] || '').not.toMatch(/https?:\/\//)
  })

  it('replaceExternalImages preserves srcset descriptors (1x/2x/w) after rewriting', () => {
    const html = '<img srcset="https://a.test/1.png 1x, https://a.test/2.png 320w">'
    const map = {
      'https://a.test/1.png': 'data:image/png;base64,AAA',
      'https://a.test/2.png': 'data:image/png;base64,BBB',
    }
    const out = replaceExternalImages(html, map)
    // Descriptors (1x, 320w) must survive unchanged next to the rewritten URLs.
    expect(out).toMatch(/data:image\/png;base64,AAA\s+1x/)
    expect(out).toMatch(/data:image\/png;base64,BBB\s+320w/)
  })

  // --- replaceExternalImages + placeholder sanity ----------------------------

  it('pipeline: extracted URL missing from inlined map never survives (regression guard)', () => {
    // Hypothetical regression: if buildExternalImageReplacementMap were changed
    // to skip placeholder fallback for URLs with a particular shape, raw URLs
    // would leak. This test locks the contract: every extracted URL must end
    // up replaced with either a data: URI or the known placeholder.
    const html = '<img src="https://leak.test/tracker.png">'
    const extracted = extractExternalImageUrls(html)
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    expect(out).not.toContain('https://leak.test/tracker.png')
    expect(out).toMatch(/src="data:/)
  })

  // --- buildMailIframeSrcDoc — P0 CSP invariant smoke ------------------------

  it('buildMailIframeSrcDoc never emits an img-src permitting http:/https: regardless of body content', () => {
    // Body HTML containing http/https does NOT influence the CSP.
    const body = '<img src="https://tracker.example.test/pixel.png"><div style="background-image:url(http://x.test/y.png)">z</div>'
    const doc = buildMailIframeSrcDoc(body, { darkMode: false })
    expect(doc).toContain("img-src 'self' data: cid:")
    expect(doc).not.toMatch(/img-src[^;"]*\b(?:https?:)/)
  })

  // --- wave-3 §3.10 P0 BLOCKER coverage ---------------------------------------
  //
  // Bypass classes that defeated the wave-1 regex extractor/replacer. Each
  // test locks a structural property of the DOM-based pipeline (sanitize
  // first → parse → walk → replace in DOM → serialize) that makes the bypass
  // impossible by construction, not by adding a special case.
  //
  // Adversarial-input helpers: the full pipeline used in App.tsx is
  // sanitize → extract → fetch → replace (with all extracted URLs mapped to
  // placeholder when fetch is skipped/fails). The unit tests replicate that
  // pipeline with an empty `inlined` map to verify the placeholder path.

  const runFullPipeline = (rawHtml: string): string => {
    const sanitized = sanitizeMailHtml(rawHtml)
    const extracted = extractExternalImageUrls(sanitized)
    const map = buildExternalImageReplacementMap(extracted, {})
    return replaceExternalImages(sanitized, map)
  }

  // BLOCKER 1 — protocol-relative bypass.
  it('pipeline rewrites protocol-relative <img src="//host/...">', () => {
    const out = runFullPipeline('<img src="//tracker.test/p.png">')
    expect(out).not.toContain('//tracker.test/p.png')
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  // BLOCKER 2a — unquoted attribute.
  it('pipeline rewrites <img src=https://...> without quotes', () => {
    const out = runFullPipeline('<img src=https://tracker.test/p.png>')
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  // BLOCKER 2b — HTML numeric-entity bypass of scheme separator.
  it('pipeline rewrites <img src="https&#58;//host/..."> (decimal entity)', () => {
    const out = runFullPipeline('<img src="https&#58;//tracker.test/p.png">')
    // After DOMPurify decodes the entity, the URL normalizes to https://…
    // and the DOM-based extractor/replacer walks the tree and replaces it.
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).not.toContain('https&#58;//tracker.test/p.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  // BLOCKER 2c — HTML hex-entity bypass (different entity encoding).
  it('pipeline rewrites <img src="&#x68;ttps://host/..."> (hex entity)', () => {
    const out = runFullPipeline('<img src="&#x68;ttps://tracker.test/p.png">')
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).not.toContain('&#x68;ttps://tracker.test/p.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  // BLOCKER 3 — 100-image payload: every URL must be replaced, not just the
  // first MAX_EXTERNAL_IMAGE_URLS the old extractor truncated to.
  it('pipeline rewrites EVERY URL in a 100-image payload (no extractor cap)', () => {
    const n = 100
    const parts: string[] = []
    for (let i = 0; i < n; i++) parts.push(`<img src="https://tracker.test/${i}.png">`)
    const html = parts.join('')

    const sanitized = sanitizeMailHtml(html)
    const extracted = extractExternalImageUrls(sanitized)
    expect(extracted.length).toBe(n)

    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(sanitized, map)

    // No raw URL survives, for any of the 100 indices.
    for (let i = 0; i < n; i++) {
      expect(out).not.toContain(`https://tracker.test/${i}.png`)
    }
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  // BLOCKER 4a — SVG <image> element (preferred outcome: dropped by sanitizer).
  it('sanitizer drops <image> SVG element (external-resource vector not covered by extractor)', () => {
    const sanitized = sanitizeMailHtml('<svg><image href="https://tracker.test/p.png"/></svg>')
    // The element name is gone entirely — DOMPurify is configured to forbid it.
    expect(sanitized.toLowerCase()).not.toMatch(/<image\b/)
    // And running the full pipeline on the raw input still produces no raw URL.
    const out = runFullPipeline('<svg><image href="https://tracker.test/p.png"/></svg>')
    expect(out).not.toContain('https://tracker.test/p.png')
  })

  // BLOCKER 4b — legacy [background] attribute on <td>.
  it('sanitizer drops [background] attribute on <td>', () => {
    const sanitized = sanitizeMailHtml('<table><tr><td background="https://tracker.test/p.png">x</td></tr></table>')
    expect(sanitized.toLowerCase()).not.toContain('background=')
    expect(sanitized).not.toContain('https://tracker.test/p.png')
    const out = runFullPipeline('<table><tr><td background="https://tracker.test/p.png">x</td></tr></table>')
    expect(out).not.toContain('https://tracker.test/p.png')
  })

  // BLOCKER 4c — legacy [background] attribute on <body>.
  it('sanitizer drops [background] attribute on <body>', () => {
    const sanitized = sanitizeMailHtml('<body background="https://tracker.test/p.png">hi</body>')
    expect(sanitized.toLowerCase()).not.toContain('background=')
    expect(sanitized).not.toContain('https://tracker.test/p.png')
  })

  // BLOCKER 4d — <base> tag (codex-security-review HIGH B4).
  //
  // <base href="https://evil.test/"> would cause every relative link in the
  // email body (e.g. <a href="/login">) to resolve against the attacker's
  // origin, surviving rewriteMailHtmlLinks() (normalizeExternalUrl returns
  // null for relative URLs). FORBID_TAGS already includes 'base', this test
  // locks the invariant against an accidental config change.
  it('sanitizer drops <base> entirely (relative URLs cannot resolve via attacker origin)', () => {
    const raw = '<base href="https://evil.test/"><a href="/login">Login</a>'
    const sanitized = sanitizeMailHtml(raw)
    expect(sanitized.toLowerCase()).not.toMatch(/<base\b/)
    expect(sanitized).not.toContain('https://evil.test')
    // The anchor itself is preserved (sanitizer is not a link-rewriter), but
    // without <base> the relative href cannot resolve via the evil origin.
    expect(sanitized).toContain('href="/login"')
  })

  // BLOCKER 4e — <meta http-equiv="refresh"> (codex-security-review HIGH B4).
  //
  // FORBID_TAGS already includes 'meta', this test locks the invariant
  // against an accidental config change. <meta http-equiv="refresh"> would
  // cause the iframe to navigate to an attacker URL automatically; even
  // though the iframe is sandboxed, we want the structural property "no
  // <meta> survives sanitization" to hold.
  it('sanitizer drops <meta http-equiv="refresh"> redirect tag', () => {
    const raw = '<meta http-equiv="refresh" content="0;url=https://evil.test/"><p>x</p>'
    const sanitized = sanitizeMailHtml(raw)
    expect(sanitized.toLowerCase()).not.toMatch(/<meta\b/)
    expect(sanitized).not.toContain('https://evil.test')
    expect(sanitized).toContain('<p>x</p>')
  })

  // --- §3.10 polish wave: sanitizer tightening (F2) ------------------------
  //
  // Residual defense-in-depth leak from wave-3: <video poster/src>,
  // <audio src>, SVG <feImage href|xlink:href> leave a raw http(s) URL in
  // the DOM even after the DOM-based extractor runs (it only walks img /
  // source / input[type=image] / [style] url()). CSP `media-src 'none'` +
  // hardened `img-src` block the actual fetch, but the invariant "no raw
  // external URL in the rendered iframe DOM" is violated. Industry
  // standard — Gmail/Outlook/Thunderbird don't render HTML-email video or
  // audio — and extending the extractor to cover these carries more risk
  // than just forbidding the tags. Fix: FORBID_TAGS += video, audio,
  // feImage. <source> stays allowed because it's legit inside <picture>.

  it('sanitizer drops <video> entirely including <source> children', () => {
    const raw = '<video poster="https://tracker.test/poster.jpg" src="https://tracker.test/v.mp4"><source src="https://tracker.test/src.mp4" type="video/mp4"/></video>'
    const sanitized = sanitizeMailHtml(raw)
    expect(sanitized.toLowerCase()).not.toMatch(/<video\b/)
    // <source> under <video> is dropped along with the parent.
    expect(sanitized).not.toContain('https://tracker.test/poster.jpg')
    expect(sanitized).not.toContain('https://tracker.test/v.mp4')
    expect(sanitized).not.toContain('https://tracker.test/src.mp4')
  })

  it('sanitizer drops <audio> entirely including <source> children', () => {
    const raw = '<audio src="https://tracker.test/a.mp3"><source src="https://tracker.test/s.ogg"/></audio>'
    const sanitized = sanitizeMailHtml(raw)
    expect(sanitized.toLowerCase()).not.toMatch(/<audio\b/)
    expect(sanitized).not.toContain('https://tracker.test/a.mp3')
    expect(sanitized).not.toContain('https://tracker.test/s.ogg')
  })

  it('sanitizer drops SVG <feImage> but preserves enclosing <filter>', () => {
    const raw = '<svg><filter id="f"><feImage href="https://tracker.test/p.png"/></filter></svg>'
    const sanitized = sanitizeMailHtml(raw)
    // feImage element gone — no raw URL survives.
    expect(sanitized).not.toMatch(/<feimage\b/i)
    expect(sanitized).not.toContain('https://tracker.test/p.png')
    // Enclosing <filter> itself may or may not be kept (DOMPurify defaults
    // drop many SVG filter primitives), but the critical property is that
    // no raw external URL leaked through feImage.
  })

  it('sanitizer preserves <source> inside <picture> (extractor still rewrites its srcset)', () => {
    // Regression guard: we deliberately did NOT add <source> to FORBID_TAGS,
    // because it's a legitimate element inside <picture> for responsive
    // images. The extractor/replacer handles <source srcset> as part of the
    // wave-3 pipeline.
    const raw = '<picture><source srcset="https://cdn.test/hi.webp 2x"/><img src="https://cdn.test/fallback.png"/></picture>'
    const sanitized = sanitizeMailHtml(raw)
    expect(sanitized.toLowerCase()).toMatch(/<source\b/)
    // Full pipeline still rewrites the external URL.
    const extracted = extractExternalImageUrls(sanitized)
    expect(extracted).toContain('https://cdn.test/hi.webp')
    expect(extracted).toContain('https://cdn.test/fallback.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(sanitized, map)
    expect(out).not.toContain('https://cdn.test/hi.webp')
    expect(out).not.toContain('https://cdn.test/fallback.png')
  })

  // --- §3.10 polish wave: CSS url() with `)` in quoted string (F3b) --------
  //
  // codex wave-2 LOW: the prior CSS_URL_RE character class `[^'")]`
  // excluded `)` even inside a quoted value, so `url('https://h/p)q.png')`
  // would not match — CSP blocks the fetch but the URL survives in the DOM
  // style attribute. New regex handles double-quoted / single-quoted /
  // unquoted as three alternatives.

  it('CSS url() with `)` in single-quoted value is extracted and replaced', () => {
    const html = `<div style="background:url('https://h.test/p)name.png')">x</div>`
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://h.test/p)name.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    expect(out).not.toContain('https://h.test/p)name.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('CSS url() with `)` in double-quoted value is extracted and replaced', () => {
    const html = `<div style='background:url("https://h.test/p)q.png")'>x</div>`
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://h.test/p)q.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    expect(out).not.toContain('https://h.test/p)q.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('CSS url() unquoted form still works (regression of existing behavior)', () => {
    const html = '<div style="background:url(https://h.test/p.png)">x</div>'
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://h.test/p.png')
    const out = replaceExternalImages(html, { 'https://h.test/p.png': 'data:image/png;base64,AAA' })
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).not.toContain('https://h.test/p.png')
  })

  it('CSS url() preserves quote style when rewriting (single-quoted)', () => {
    // Replacer keeps `url('…')` shape. Raw URL removed, quoted form survives.
    const html = `<div style="background:url('https://h.test/a.png')">x</div>`
    const out = replaceExternalImages(html, { 'https://h.test/a.png': 'data:image/png;base64,AA' })
    expect(out).not.toContain('https://h.test/a.png')
    expect(out).toContain(`url('data:image/png;base64,AA')`)
  })

  it('CSS url() with double-quoted value is rewritten (quoted form survives)', () => {
    // jsdom may serialize the outer `"` as `&quot;` when the attribute is
    // already double-quoted, but the structural property — raw URL gone,
    // replacement present — is what matters for security. The full
    // extractor + replacer pipeline round-trips correctly on the output.
    const html = `<div style='background:url("https://h.test/b.png")'>x</div>`
    const out = replaceExternalImages(html, { 'https://h.test/b.png': 'data:image/png;base64,BB' })
    expect(out).not.toContain('https://h.test/b.png')
    expect(out).toContain('data:image/png;base64,BB')
  })

  // --- §3.10 polish wave: banner derivation (F3a) --------------------------
  //
  // hasExternalImagesInHtml now derives from the extractor on sanitized
  // input instead of a regex heuristic — same authoritative path the
  // security pipeline uses, so banner visibility matches what
  // replaceExternalImages actually rewrites. This locks parity across
  // bypass classes that would have fooled the old regex.

  it('hasExternalImagesInHtml detects entity-encoded scheme', () => {
    expect(hasExternalImagesInHtml('<img src="https&#58;//tracker.test/p.png">')).toBe(true)
  })

  it('hasExternalImagesInHtml detects unquoted attribute', () => {
    expect(hasExternalImagesInHtml('<img src=https://tracker.test/p.png>')).toBe(true)
  })

  it('hasExternalImagesInHtml detects CSS url() with `)` in quoted value', () => {
    expect(hasExternalImagesInHtml(`<div style="background:url('https://h.test/p)name.png')">x</div>`)).toBe(true)
  })

  it('hasExternalImagesInHtml returns false for forbidden tags (video/audio/feImage)', () => {
    // After sanitizer drops these tags, no external URL remains — banner
    // correctly suppressed. This is the authoritative-derivation property.
    expect(hasExternalImagesInHtml('<video src="https://tracker.test/v.mp4"></video>')).toBe(false)
    expect(hasExternalImagesInHtml('<audio src="https://tracker.test/a.mp3"></audio>')).toBe(false)
  })

  // Regression: wave-1 composite test covered sanitized HTML with already-decoded
  // attributes. wave-3 adds the hard case — adversarial RAW input through the
  // full pipeline always arrives at the hardened output.
  it('pipeline rewrites a mixed-bypass adversarial payload in one pass', () => {
    const adversarial = [
      '<img src="//a.test/1.png">',
      '<img src=https://b.test/2.png>',
      '<img src="https&#58;//c.test/3.png">',
      '<img src="&#x68;ttps://d.test/4.png">',
      '<svg><image href="https://e.test/5.png"/></svg>',
      '<td background="https://f.test/6.png">x</td>',
      '<body background="https://g.test/7.png">y</body>',
      '<input type="image" src="//h.test/8.png">',
      '<img srcset="//i.test/9.png 1x, https://j.test/10.png 2x">',
      '<div style="background-image:url(//k.test/11.png);content:url(https&#58;//l.test/12.png)">z</div>',
    ].join('')

    const out = runFullPipeline(adversarial)
    for (const host of ['a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test', 'g.test', 'h.test', 'i.test', 'j.test', 'k.test', 'l.test']) {
      // No raw or protocol-relative form of any host survives.
      expect(out).not.toContain(`//${host}`)
      expect(out).not.toContain(`https://${host}`)
      expect(out).not.toContain(`http://${host}`)
    }
  })

  // --- §3.10 polish wave: CSS_URL_RE defensive edges -----------------------
  //
  // Ensure the 3-alternative regex does not over-match degenerate CSS forms
  // that never carry a schemed URL. Empty `url()` and whitespace-only
  // `url(   )` must be no-ops — they would produce `null` from the extractor
  // and zero rewrites from the replacer. If the regex started matching these
  // it would either add spurious keys to the fetch budget or corrupt the
  // style attribute on round-trip.

  it('CSS url() empty or whitespace-only yields no extracted URLs (no spurious match)', () => {
    expect(extractExternalImageUrls('<div style="background:url()">x</div>')).toEqual([])
    expect(extractExternalImageUrls('<div style="background:url(   )">x</div>')).toEqual([])
    // Replacer must also be a no-op for these — style attribute survives
    // unchanged in form (value preserved, no crash).
    const html = '<div style="background:url(   )">x</div>'
    expect(replaceExternalImages(html, {})).toBe(html)
  })

  // --- §3.10 polish wave: CSS comment bypass (codex NEEDS_FIX BLOCKER) -----
  //
  // CSS spec permits block comments (slash-star ... star-slash) anywhere
  // whitespace is allowed, including between `url(` and the URL token.
  // Browsers parse and fetch those URLs. Before this fix, CSS_URL_RE saw `/`
  // as the first meaningful char after `url(\s*` and failed to match,
  // leaving the raw http(s) URL in the rendered iframe DOM — violating the
  // §3.10 invariant "no raw http(s) URL in rendered iframe DOM". Fix: strip
  // CSS comments before the extractor / replacer run (DOM-level, applied to
  // both `[style]` attributes and `<style>` textContent).
  //
  // Test strings must contain the real comment delimiter characters; we
  // construct them via `C_OPEN = '/' + '*'` / `C_CLOSE = '*' + '/'` so the
  // source file itself contains no block-comment syntax that could confuse
  // editors or tooling.
  const C_OPEN = '/' + '*'
  const C_CLOSE = '*' + '/'

  it('pipeline rewrites <div style="background:url(comment https://...)">', () => {
    const html = `<div style="background:url(${C_OPEN}${C_CLOSE}https://tracker.test/p.png)">x</div>`
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://tracker.test/p.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    expect(out).not.toContain('https://tracker.test/p.png')
    // No comment delimiter survives in the rewritten attribute either — the
    // stripped form is what gets written back.
    expect(out).not.toContain(C_OPEN)
    expect(out).not.toContain(C_CLOSE)
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('pipeline rewrites url(<css comment>https://...) inside a <style> block', () => {
    const html = `<style>.bg{background:url(${C_OPEN} comment ${C_CLOSE}https://tracker.test/p.png)}</style>`
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://tracker.test/p.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).not.toContain('tracker.test')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('pipeline rewrites URL when a top-level <style> comment precedes the rule', () => {
    const html = `<style>${C_OPEN} top-level comment ${C_CLOSE}.bg{background:url(https://tracker.test/p.png)}</style>`
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://tracker.test/p.png')
    const map = buildExternalImageReplacementMap(extracted, {})
    const out = replaceExternalImages(html, map)
    // URL is rewritten; the top-level comment MAY be stripped (the replacer
    // writes back the normalized form). Either way no raw URL survives.
    expect(out).not.toContain('https://tracker.test/p.png')
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })

  it('regression: url() without any comments still works (no spurious stripping)', () => {
    // Locks the existing no-comment path — stripCssComments is a superset of
    // identity on comment-free CSS, so matching behavior is unchanged.
    const html = '<div style="background:url(https://tracker.test/p.png)">x</div>'
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://tracker.test/p.png')
    const out = replaceExternalImages(html, { 'https://tracker.test/p.png': 'data:image/png;base64,AAA' })
    expect(out).toContain('data:image/png;base64,AAA')
    expect(out).not.toContain('https://tracker.test/p.png')
  })

  it('CSS url() inside a surviving <style> block is extracted AND rewritten by the replacer', () => {
    // The extractor already covers <style> textContent (existing test at
    // "extractExternalImageUrls covers CSS url() in various properties").
    // What wasn't locked in is the REPLACER round-tripping through
    // <style> textContent — if the replacer only rewrote [style] attributes
    // and missed <style> elements, an @font-face or inline rule would still
    // leak a raw http(s) URL into the iframe DOM.
    const html = '<style>.bg{background-image:url(https://s.test/sheet.png)}</style><div class="bg">x</div>'
    const extracted = extractExternalImageUrls(html)
    expect(extracted).toContain('https://s.test/sheet.png')
    const out = replaceExternalImages(html, { 'https://s.test/sheet.png': BLOCKED_IMAGE_PLACEHOLDER_DATA_URI })
    // Raw URL gone from <style> block.
    expect(out).not.toContain('https://s.test/sheet.png')
    // Placeholder sits in the <style> rule.
    expect(out).toContain(BLOCKED_IMAGE_PLACEHOLDER_DATA_URI)
  })
})
