import { describe, expect, it, vi } from 'vitest'
import {
  tryRfc8058Post,
  tryHttpGetUnsubscribe,
  tryAutoUnsubscribe,
  pickHttpsUrl,
  extractUnsubLinksFromHtml,
} from './unsubscribe'
import type { SafeRemoteRequestOptions, SafeRemoteStatusResponse } from './safeRemoteFetch'

describe('packages/net/unsubscribe', () => {
  const makeRequestStatus = (impl?: (url: string, options?: SafeRemoteRequestOptions) => Promise<SafeRemoteStatusResponse>) =>
    vi.fn(impl ?? (() => Promise.resolve({ url: 'https://example.com/unsub', status: 200, headers: {} })))

  describe('pickHttpsUrl', () => {
    it('picks first HTTPS URL', () => {
      expect(pickHttpsUrl([
        'mailto:unsub@example.com',
        'https://example.com/unsub',
        'https://example.com/unsub2',
      ])).toBe('https://example.com/unsub')
    })

    it('returns null for mailto-only links', () => {
      expect(pickHttpsUrl(['mailto:unsub@example.com'])).toBeNull()
    })

    it('returns null for empty list', () => {
      expect(pickHttpsUrl([])).toBeNull()
    })

    it('skips http:// URLs (not HTTPS)', () => {
      expect(pickHttpsUrl(['http://example.com/unsub'])).toBeNull()
    })

    it('trims whitespace', () => {
      expect(pickHttpsUrl(['  https://example.com/unsub  '])).toBe('https://example.com/unsub')
    })
  })

  describe('tryRfc8058Post', () => {
    it('returns ok=true on 200 response', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryRfc8058Post('https://example.com/unsub', 'List-Unsubscribe=One-Click', requestStatus)

      expect(result.ok).toBe(true)
      expect(result.method).toBe('rfc8058_post')
      expect(result.httpStatus).toBe(200)
      expect(result.detail).toContain('succeeded')
    })

    it('sends correct POST body and headers', async () => {
      const requestStatus = makeRequestStatus()

      await tryRfc8058Post('https://example.com/unsub', 'List-Unsubscribe=One-Click', requestStatus)

      const call = requestStatus.mock.calls[0]
      const options = call[1]
      expect(call[0]).toBe('https://example.com/unsub')
      expect(options?.method).toBe('POST')
      expect(options?.body).toBe('List-Unsubscribe=One-Click')
      expect(options?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(options?.headers?.['User-Agent']).toContain('MailCopilot')
    })

    it('returns ok=false on 403 response', async () => {
      const requestStatus = makeRequestStatus(() => Promise.resolve({ url: 'https://example.com/unsub', status: 403, headers: {} }))

      const result = await tryRfc8058Post('https://example.com/unsub', 'List-Unsubscribe=One-Click', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.httpStatus).toBe(403)
      expect(result.detail).toContain('403')
    })

    it('returns ok=false for non-HTTPS URL without making a request', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryRfc8058Post('http://example.com/unsub', 'List-Unsubscribe=One-Click', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('not HTTPS')
      expect(requestStatus).not.toHaveBeenCalled()
    })

    it('handles network errors', async () => {
      const requestStatus = makeRequestStatus(() => Promise.reject(new Error('ECONNREFUSED')))

      const result = await tryRfc8058Post('https://example.com/unsub', 'List-Unsubscribe=One-Click', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('ECONNREFUSED')
    })

    it('trims listUnsubscribePost value', async () => {
      const requestStatus = makeRequestStatus()

      await tryRfc8058Post('https://example.com/unsub', '  List-Unsubscribe=One-Click  ', requestStatus)

      const call = requestStatus.mock.calls[0]
      expect(call[1]?.body).toBe('List-Unsubscribe=One-Click')
    })
  })

  describe('tryHttpGetUnsubscribe', () => {
    it('returns ok=true on 200 response', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryHttpGetUnsubscribe('https://example.com/unsub', requestStatus)

      expect(result.ok).toBe(true)
      expect(result.method).toBe('http_get')
      expect(result.httpStatus).toBe(200)
    })

    it('sends GET with User-Agent header', async () => {
      const requestStatus = makeRequestStatus()

      await tryHttpGetUnsubscribe('https://example.com/unsub', requestStatus)

      const call = requestStatus.mock.calls[0]
      expect(call[1]?.method).toBe('GET')
      expect(call[1]?.headers?.['User-Agent']).toContain('MailCopilot')
    })

    it('returns ok=false for non-HTTPS URL', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryHttpGetUnsubscribe('http://example.com/unsub', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('not HTTPS')
      expect(requestStatus).not.toHaveBeenCalled()
    })

    it('returns ok=false on 500 response', async () => {
      const requestStatus = makeRequestStatus(() => Promise.resolve({ url: 'https://example.com/unsub', status: 500, headers: {} }))

      const result = await tryHttpGetUnsubscribe('https://example.com/unsub', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.httpStatus).toBe(500)
    })

    it('handles network errors', async () => {
      const requestStatus = makeRequestStatus(() => Promise.reject(new Error('ETIMEDOUT')))

      const result = await tryHttpGetUnsubscribe('https://example.com/unsub', requestStatus)

      expect(result.ok).toBe(false)
      expect(result.detail).toContain('ETIMEDOUT')
    })
  })

  describe('tryAutoUnsubscribe', () => {
    it('prefers RFC 8058 POST when listUnsubscribePost is present', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryAutoUnsubscribe(
        ['https://example.com/unsub', 'mailto:unsub@example.com'],
        'List-Unsubscribe=One-Click',
        requestStatus,
      )

      expect(result?.ok).toBe(true)
      expect(result?.method).toBe('rfc8058_post')
      expect(requestStatus).toHaveBeenCalledTimes(1)
    })

    it('falls back to GET when POST fails', async () => {
      let callCount = 0
      const requestStatus = makeRequestStatus(() => {
        callCount++
        if (callCount === 1) return Promise.resolve({ url: 'https://example.com/unsub', status: 500, headers: {} })
        return Promise.resolve({ url: 'https://example.com/unsub', status: 200, headers: {} })
      })

      const result = await tryAutoUnsubscribe(
        ['https://example.com/unsub'],
        'List-Unsubscribe=One-Click',
        requestStatus,
      )

      expect(result?.ok).toBe(true)
      expect(result?.method).toBe('http_get')
      expect(requestStatus).toHaveBeenCalledTimes(2)
    })

    it('uses GET when no listUnsubscribePost header', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryAutoUnsubscribe(
        ['https://example.com/unsub'],
        undefined,
        requestStatus,
      )

      expect(result?.ok).toBe(true)
      expect(result?.method).toBe('http_get')
    })

    it('returns null when only mailto: links', async () => {
      const result = await tryAutoUnsubscribe(
        ['mailto:unsub@example.com'],
        undefined,
      )

      expect(result).toBeNull()
    })

    it('returns null for empty links', async () => {
      const result = await tryAutoUnsubscribe([], undefined)

      expect(result).toBeNull()
    })

    it('skips POST for non-matching listUnsubscribePost value', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryAutoUnsubscribe(
        ['https://example.com/unsub'],
        'SomethingElse',
        requestStatus,
      )

      expect(result?.method).toBe('http_get')
      expect(requestStatus).toHaveBeenCalledTimes(1)
    })

    it('handles case-insensitive List-Unsubscribe-Post value', async () => {
      const requestStatus = makeRequestStatus()

      const result = await tryAutoUnsubscribe(
        ['https://example.com/unsub'],
        'list-unsubscribe=one-click',
        requestStatus,
      )

      expect(result?.method).toBe('rfc8058_post')
    })
  })

  describe('extractUnsubLinksFromHtml', () => {
    it('extracts link by English text keyword', () => {
      const html = '<a href="https://example.com/unsub">Unsubscribe</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsub'])
    })

    it('extracts link by Russian text keyword', () => {
      const html = '<a href="https://example.com/remove">Отписаться</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/remove'])
    })

    it('extracts link by URL keyword even without text match', () => {
      const html = '<a href="https://example.com/unsubscribe?id=123">Click here</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsubscribe?id=123'])
    })

    it('extracts link with opt-out URL pattern', () => {
      const html = '<a href="https://example.com/opt-out/abc">Manage preferences</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/opt-out/abc'])
    })

    it('extracts link with list-manage URL pattern', () => {
      const html = '<a href="https://list-manage.com/unsub?u=abc">here</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://list-manage.com/unsub?u=abc'])
    })

    it('skips http:// links (not HTTPS)', () => {
      const html = '<a href="http://example.com/unsubscribe">Unsubscribe</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual([])
    })

    it('returns empty array for empty input', () => {
      expect(extractUnsubLinksFromHtml('')).toEqual([])
    })

    it('returns empty array for HTML without unsubscribe links', () => {
      const html = '<a href="https://example.com/about">About us</a><a href="https://example.com/contact">Contact</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual([])
    })

    it('deduplicates identical URLs', () => {
      const html = `
        <a href="https://example.com/unsub">Unsubscribe</a>
        <a href="https://example.com/unsub">Отписаться</a>
      `
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsub'])
    })

    it('handles case-insensitive text matching', () => {
      const html = '<a href="https://example.com/remove">UNSUBSCRIBE</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/remove'])
    })

    it('handles case-insensitive URL matching', () => {
      const html = '<a href="https://example.com/Unsubscribe?id=1">Click</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/Unsubscribe?id=1'])
    })

    it('extracts link with nested HTML tags in anchor text', () => {
      const html = '<a href="https://example.com/unsub"><span style="color:gray">Отписаться</span></a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsub'])
    })

    it('extracts multiple different unsubscribe links', () => {
      const html = `
        <a href="https://example.com/unsub1">Unsubscribe</a>
        <a href="https://example.com/unsub2">Opt out</a>
      `
      const result = extractUnsubLinksFromHtml(html)
      expect(result).toEqual(['https://example.com/unsub1', 'https://example.com/unsub2'])
    })

    it('handles single-quoted href attributes', () => {
      const html = "<a href='https://example.com/unsub'>Unsubscribe</a>"
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsub'])
    })

    it('handles href with extra attributes', () => {
      const html = '<a class="link" href="https://example.com/unsub" target="_blank">Unsubscribe</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.com/unsub'])
    })

    it('extracts German keyword link', () => {
      const html = '<a href="https://example.de/remove">Abmelden</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.de/remove'])
    })

    it('extracts French keyword link', () => {
      const html = '<a href="https://example.fr/remove">Se désabonner</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.fr/remove'])
    })

    it('extracts Spanish keyword link', () => {
      const html = '<a href="https://example.es/remove">Cancelar suscripción</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.es/remove'])
    })

    it('extracts Italian keyword link', () => {
      const html = '<a href="https://example.it/remove">Annulla iscrizione</a>'
      expect(extractUnsubLinksFromHtml(html)).toEqual(['https://example.it/remove'])
    })
  })
})
