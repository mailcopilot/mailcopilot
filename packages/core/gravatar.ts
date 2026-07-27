/** SHA-256 hash of a string via Web Crypto API. */
export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// --- In-memory Gravatar URL cache ---

type GravatarEntry = { url: string } | { notFound: true; ts: number }

/** TTL for 404 results (1 hour). */
const NOT_FOUND_TTL = 60 * 60 * 1000

const entries = new Map<string, GravatarEntry>()
const pending = new Set<string>()

/**
 * Synchronous access to cached Gravatar URL.
 * Returns URL or null (not computed / 404 / TTL not expired).
 */
export function getGravatarUrl(email: string): string | null {
  const key = email.trim().toLowerCase()
  if (!key) return null
  const entry = entries.get(key)
  if (!entry) return null
  if ('notFound' in entry) {
    if (Date.now() - entry.ts < NOT_FOUND_TTL) return null
    entries.delete(key)
    return null
  }
  return entry.url
}

/**
 * Starts async SHA-256 computation for an email and caches the Gravatar URL.
 * Idempotent — repeated calls for the same email are ignored.
 * @param onReady — callback to trigger re-render (called after caching).
 */
export function precomputeGravatarHash(email: string, size: number, onReady: () => void): void {
  const key = email.trim().toLowerCase()
  if (!key || entries.has(key) || pending.has(key)) return
  pending.add(key)
  sha256hex(key)
    .then(hash => {
      entries.set(key, { url: `https://www.gravatar.com/avatar/${hash}?d=404&s=${size}` })
      onReady()
    })
    .catch(() => {
      entries.set(key, { notFound: true, ts: Date.now() })
    })
    .finally(() => { pending.delete(key) })
}

/** Marks an email as having no Gravatar (called on <img> onError). */
export function markGravatarNotFound(email: string): void {
  const key = email.trim().toLowerCase()
  if (key) entries.set(key, { notFound: true, ts: Date.now() })
}

/** Clear cache (for tests). */
export function clearGravatarCache(): void {
  entries.clear()
  pending.clear()
}
