/**
 * Automatic HTTP-based email unsubscribe (RFC 8058 + HTTP GET fallback).
 *
 * Strategy:
 * 1. If RFC 8058 List-Unsubscribe-Post header present → HTTP POST one-click
 * 2. If only HTTPS URL exists (no Post header) → HTTP GET
 * 3. Caller falls back to shell.openExternal() on failure
 */
import { requestSafeRemoteStatus, type SafeRemoteRequestOptions, type SafeRemoteStatusResponse } from './safeRemoteFetch'

const UNSUBSCRIBE_TIMEOUT_MS = 12_000
const USER_AGENT = 'Mozilla/5.0 (compatible; MailCopilot/1.0)'

type StatusRequester = (
  url: string,
  options?: SafeRemoteRequestOptions,
) => Promise<SafeRemoteStatusResponse>

export type HttpUnsubscribeResult = {
  method: 'rfc8058_post' | 'http_get'
  ok: boolean
  httpStatus?: number
  detail: string
}

/**
 * Pick the first HTTPS URL from List-Unsubscribe links.
 * Skips http:// and mailto: — only HTTPS is safe for auto-unsubscribe.
 */
export function pickHttpsUrl(links: string[]): string | null {
  for (const link of links) {
    const trimmed = link.trim()
    if (trimmed.startsWith('https://')) return trimmed
  }
  return null
}

/**
 * Attempt RFC 8058 One-Click Unsubscribe via HTTP POST.
 *
 * Sends POST to the HTTPS URL with body from List-Unsubscribe-Post header
 * (typically "List-Unsubscribe=One-Click") and Content-Type
 * "application/x-www-form-urlencoded".
 */
export async function tryRfc8058Post(
  url: string,
  listUnsubscribePost: string,
  requestStatus: StatusRequester = requestSafeRemoteStatus,
): Promise<HttpUnsubscribeResult> {
  if (!url.startsWith('https://')) {
    return { method: 'rfc8058_post', ok: false, detail: 'URL is not HTTPS, skipping auto-unsubscribe' }
  }

  try {
    const body = listUnsubscribePost.trim()
    const response = await requestStatus(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body,
      timeoutMs: UNSUBSCRIBE_TIMEOUT_MS,
    })
    const ok = response.status >= 200 && response.status < 300

    return {
      method: 'rfc8058_post',
      ok,
      httpStatus: response.status,
      detail: ok
        ? `RFC 8058 one-click unsubscribe succeeded (HTTP ${response.status})`
        : `RFC 8058 POST returned HTTP ${response.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { method: 'rfc8058_post', ok: false, detail: `RFC 8058 POST failed: ${msg}` }
  }
}

/**
 * Attempt HTTP GET unsubscribe (fallback for emails without RFC 8058).
 *
 * Sends GET to the HTTPS URL and checks for 2xx response.
 * Note: many servers show a confirmation page on GET, so 2xx does not
 * guarantee unsubscribe completed — but it's better than opening a browser.
 */
export async function tryHttpGetUnsubscribe(
  url: string,
  requestStatus: StatusRequester = requestSafeRemoteStatus,
): Promise<HttpUnsubscribeResult> {
  if (!url.startsWith('https://')) {
    return { method: 'http_get', ok: false, detail: 'URL is not HTTPS, skipping auto-unsubscribe' }
  }

  try {
    const response = await requestStatus(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      timeoutMs: UNSUBSCRIBE_TIMEOUT_MS,
    })
    const ok = response.status >= 200 && response.status < 300

    return {
      method: 'http_get',
      ok,
      httpStatus: response.status,
      detail: ok
        ? `HTTP GET unsubscribe request succeeded (HTTP ${response.status})`
        : `HTTP GET returned HTTP ${response.status}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { method: 'http_get', ok: false, detail: `HTTP GET unsubscribe failed: ${msg}` }
  }
}

// ---------------------------------------------------------------------------
// Body-link extraction: fallback when List-Unsubscribe header is missing
// ---------------------------------------------------------------------------

/** Anchor-tag regex: captures href and inner text (non-greedy). */
const ANCHOR_RE = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi

/** Keywords in link text that indicate an unsubscribe action (case-insensitive). */
const TEXT_KEYWORDS = [
  'unsubscribe',
  'opt out',
  'opt-out',
  'отписаться',
  'отписка',
  'désabonner',
  'désinscrire',
  'abmelden',
  'abbestellen',
  'cancelar suscripción',
  'darse de baja',
  'annulla iscrizione',
  'disiscriviti',
]

/** Keywords in URL path that indicate an unsubscribe endpoint. */
const URL_KEYWORDS = [
  'unsubscribe',
  'unsub',
  'opt-out',
  'opt_out',
  'optout',
  'list-manage',
]

/**
 * Extract unsubscribe HTTPS links from HTML body.
 *
 * Scans `<a href="…">text</a>` for keywords in either the visible text
 * or the URL itself. Returns deduplicated HTTPS URLs only.
 */
export function extractUnsubLinksFromHtml(html: string): string[] {
  if (!html) return []

  const out: string[] = []

  let m: RegExpExecArray | null
  // Reset lastIndex before exec loop
  ANCHOR_RE.lastIndex = 0
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1].trim()
    if (!href.startsWith('https://')) continue

    // Strip HTML tags from inner text for keyword matching
    const text = m[2].replace(/<[^>]*>/g, '').trim().toLowerCase()
    const hrefLower = href.toLowerCase()

    const textMatch = TEXT_KEYWORDS.some(kw => text.includes(kw))
    const urlMatch = URL_KEYWORDS.some(kw => hrefLower.includes(kw))

    if (textMatch || urlMatch) {
      out.push(href)
    }
  }

  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Attempt automatic HTTP unsubscribe for a single message.
 *
 * 1. If listUnsubscribePost is present + HTTPS URL exists → RFC 8058 POST
 * 2. If POST fails or no Post header → HTTP GET to HTTPS URL
 * 3. Returns null if no HTTPS URL available (only mailto: links)
 *
 * Does NOT open the browser — that's the caller's responsibility on failure.
 */
export async function tryAutoUnsubscribe(
  links: string[],
  listUnsubscribePost?: string,
  requestStatus: StatusRequester = requestSafeRemoteStatus,
): Promise<HttpUnsubscribeResult | null> {
  const httpsUrl = pickHttpsUrl(links)
  if (!httpsUrl) return null

  // Strategy 1: RFC 8058 one-click POST
  if (listUnsubscribePost && /List-Unsubscribe=One-Click/i.test(listUnsubscribePost)) {
    const postResult = await tryRfc8058Post(httpsUrl, listUnsubscribePost, requestStatus)
    if (postResult.ok) return postResult
    // POST failed — fall through to GET
  }

  // Strategy 2: HTTP GET (less reliable but better than nothing)
  return tryHttpGetUnsubscribe(httpsUrl, requestStatus)
}
