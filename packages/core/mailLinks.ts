const ROUTED_LINK_PROTOCOL = 'mailcopilot-link:'
const ROUTED_LINK_ORIGIN = 'mailcopilot-link://open'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function normalizeExternalUrl(raw: string): string | null {
  const s = (raw || '').trim()
  if (!s) return null

  try {
    // Absolute URL with a scheme (http/https/mailto).
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
      const u = new URL(s)
      if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null
      return u.toString()
    }

    // Protocol-relative.
    if (s.startsWith('//')) {
      const u = new URL(`https:${s}`)
      if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null
      return u.toString()
    }

    // Bare domain (google.com[/...]) -> https://...
    if (/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/|$)/i.test(s)) {
      const u = new URL(`https://${s}`)
      if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null
      return u.toString()
    }
  } catch {
    return null
  }

  return null
}

export function buildRoutedMailLink(normalizedExternalUrl: string, text: string): string {
  const u = encodeURIComponent(normalizedExternalUrl)
  const t = encodeURIComponent((text || '').trim().slice(0, 500))
  return `${ROUTED_LINK_ORIGIN}?u=${u}&t=${t}`
}

export function isRoutedMailLink(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    return u.protocol === ROUTED_LINK_PROTOCOL
  } catch {
    return false
  }
}
