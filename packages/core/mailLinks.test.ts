import { describe, expect, it } from 'vitest'
import { normalizeExternalUrl, buildRoutedMailLink, isRoutedMailLink } from './mailLinks'

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
