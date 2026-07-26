// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { normalizeExternalUrl, buildRoutedMailLink, rewriteMailHtmlLinks, isRoutedMailLink } from './mailLinks'

describe('normalizeExternalUrl', () => {
  it('normalizes https URL', () => {
    expect(normalizeExternalUrl('https://example.com')).toBe('https://example.com/')
  })

  it('normalizes http URL', () => {
    expect(normalizeExternalUrl('http://example.com/page')).toBe('http://example.com/page')
  })

  it('normalizes mailto URL', () => {
    expect(normalizeExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com')
  })

  it('adds https to bare domains', () => {
    expect(normalizeExternalUrl('example.com')).toBe('https://example.com/')
  })

  it('handles protocol-relative URL', () => {
    expect(normalizeExternalUrl('//example.com/page')).toBe('https://example.com/page')
  })

  it('rejects javascript: URL', () => {
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects empty string', () => {
    expect(normalizeExternalUrl('')).toBeNull()
  })

  it('rejects ftp: URL', () => {
    expect(normalizeExternalUrl('ftp://example.com')).toBeNull()
  })
})

describe('buildRoutedMailLink', () => {
  it('builds a mailcopilot-link URL', () => {
    const result = buildRoutedMailLink('https://example.com/', 'Example')
    expect(result).toContain('mailcopilot-link://open?u=')
    expect(result).toContain(encodeURIComponent('https://example.com/'))
    expect(result).toContain(encodeURIComponent('Example'))
  })
})

describe('isRoutedMailLink', () => {
  it('detects mailcopilot-link URL', () => {
    expect(isRoutedMailLink('mailcopilot-link://open?u=https%3A%2F%2Fexample.com&t=test')).toBe(true)
  })

  it('does not detect regular URLs', () => {
    expect(isRoutedMailLink('https://example.com')).toBe(false)
  })
})

describe('rewriteMailHtmlLinks', () => {
  it('rewrites href to mailcopilot-link', () => {
    const html = '<a href="https://example.com">Click me</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('mailcopilot-link://open')
    expect(result).not.toContain('href="https://example.com"')
  })

  it('adds target="_top" to links', () => {
    const html = '<a href="https://example.com">Link</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('target="_top"')
  })

  it('adds rel="noreferrer noopener"', () => {
    const html = '<a href="https://example.com">Link</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('rel="noreferrer noopener"')
  })

  it('adds title with domain', () => {
    const html = '<a href="https://example.com/path">Link</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('title="https://example.com"')
  })

  it('does not rewrite anchor links (#)', () => {
    const html = '<a href="#section">Section</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('href="#section"')
    expect(result).not.toContain('mailcopilot-link')
  })

  it('does not rewrite empty href', () => {
    const html = '<a href="">Empty</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).not.toContain('mailcopilot-link')
  })

  it('rewrites mailto links', () => {
    const html = '<a href="mailto:test@example.com">Email</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('mailcopilot-link://open')
  })

  it('handles multiple links', () => {
    const html = '<a href="https://a.com">A</a> <a href="https://b.com">B</a>'
    const result = rewriteMailHtmlLinks(html)
    const matches = result.match(/mailcopilot-link/g)
    expect(matches).toHaveLength(2)
    // Both links should have target="_top"
    const targetMatches = result.match(/target="_top"/g)
    expect(targetMatches).toHaveLength(2)
  })

  // --- codex-security-review HIGH B4: <area> in image maps ---------------
  //
  // Before this fix, querySelectorAll('a[href]') alone missed `<area href>`
  // elements inside `<map>`, leaving raw http(s) hrefs in the rendered DOM
  // where the will-frame-navigate fallback in main.ts would shell.openExternal()
  // them without going through the phishing-warning UI. The rewriter now
  // covers both <a href> and <area href>.

  it('rewrites <area href> in image maps to mailcopilot-link', () => {
    const html = '<map name="m"><area shape="rect" coords="0,0,10,10" href="https://evil.test/login" alt="x"></map>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('mailcopilot-link://open')
    expect(result).not.toMatch(/href\s*=\s*["']https:\/\/evil\.test/)
    // Routed link must encode the original URL.
    expect(result).toContain(encodeURIComponent('https://evil.test/login'))
  })

  it('adds rel and target on rewritten <area> elements', () => {
    const html = '<map name="m"><area href="https://example.com" alt="x"></map>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('target="_top"')
    expect(result).toContain('rel="noreferrer noopener"')
  })

  it('rewrites BOTH <a href> and <area href> in mixed payload', () => {
    const html = [
      '<a href="https://a.test/page">A</a>',
      '<map name="m"><area href="https://b.test/page" alt="x"></map>',
    ].join('')
    const result = rewriteMailHtmlLinks(html)
    const matches = result.match(/mailcopilot-link/g)
    expect(matches).toHaveLength(2)
    expect(result).not.toMatch(/href\s*=\s*["']https:\/\/a\.test/)
    expect(result).not.toMatch(/href\s*=\s*["']https:\/\/b\.test/)
  })

  it('does not rewrite <area href="#anchor"> (anchor href stays)', () => {
    const html = '<map name="m"><area href="#section" alt="x"></map>'
    const result = rewriteMailHtmlLinks(html)
    expect(result).toContain('href="#section"')
    expect(result).not.toContain('mailcopilot-link')
  })

  // --- codex-security-review HIGH B4: <base> defense-in-depth ------------
  //
  // sanitizeMailHtml already drops <base> via FORBID_TAGS, but the rewriter
  // also strips <base> as a defense-in-depth layer so that even if an
  // upstream change accidentally allowed <base> back in, it cannot influence
  // how <a href="/relative"> is resolved in the iframe DOM.

  it('strips <base href> from body so relative URLs cannot resolve via attacker origin', () => {
    const html = '<base href="https://evil.test/"><a href="/login">Login</a>'
    const result = rewriteMailHtmlLinks(html)
    expect(result.toLowerCase()).not.toMatch(/<base\b/)
    // The relative <a href="/login"> remains untouched (normalizeExternalUrl
    // returns null for relative URLs), but with <base> gone it cannot resolve
    // against evil.test in the renderer iframe.
    expect(result).toContain('href="/login"')
  })

  it('strips multiple <base> elements regardless of position', () => {
    const html = '<base href="https://e.test/"><p>x</p><base href="https://f.test/">'
    const result = rewriteMailHtmlLinks(html)
    expect(result.toLowerCase()).not.toMatch(/<base\b/)
  })
})
