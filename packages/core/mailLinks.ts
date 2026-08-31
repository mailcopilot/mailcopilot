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

/**
 * Upper bound on the `t` (visible link text) parameter of a routed mail link.
 *
 * `t` is NOT an address — it is only the heuristic input to the display/target
 * mismatch warning in `useMailLinkClick`. A host claim a human can actually read
 * off a link is far shorter than this; the bound exists so a mail-supplied blob
 * cannot be pushed through the routed-link channel.
 *
 * The reader (`parseRoutedMailLink` in electron/mailLinkRouter.ts) enforces the
 * SAME bound, so a link this function built round-trips unchanged while a link
 * an email planted itself cannot exceed it. Keeping the constant here — on the
 * writing side — makes the two sides provably the same number rather than two
 * literals that drift apart.
 */
export const MAX_ROUTED_LINK_TEXT_LENGTH = 500

export function buildRoutedMailLink(normalizedExternalUrl: string, text: string): string {
  const u = encodeURIComponent(normalizedExternalUrl)
  const t = encodeURIComponent((text || '').trim().slice(0, MAX_ROUTED_LINK_TEXT_LENGTH))
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
