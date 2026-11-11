import { BLOCKED_IMAGE_PLACEHOLDER_DATA_URI } from './mail'

/**
 * Progressive image loading for the mail iframe (§2.308).
 *
 * The body is handed to the iframe as soon as it is sanitized. Every inline
 * (CID) image and every external image we are going to fetch starts out as the
 * inert placeholder data: URI, made unique by a fragment — a *pending token*.
 * When the bytes arrive, the token is swapped for the real `data:` URI in the
 * live document, so the iframe is never reloaded and the scroll position stays.
 *
 * Tokens are minted per pipeline run with an unguessable random run id, so a
 * sender can not predict one and write it into the message to make the patcher
 * touch a position of their choosing. What keeps one message's late bytes out
 * of another message's document is, however, not the token: it is the run's own
 * `cancelled` flag, the per-run map of arrived bytes, and the iframe remount per
 * message. A raw http(s) URL is never present at any moment; an image that never
 * arrives simply stays the placeholder.
 */

const TOKEN_MARK = '#mcimg-'

/** A fresh unguessable id for one pipeline run (128 random bits, hex). */
export function newPendingRunId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** Placeholder + fragment unique to (run, index). `~` ends the index, so `1` can not match inside `10`. */
export function pendingImageToken(runId: string, index: number): string {
  return `${BLOCKED_IMAGE_PLACEHOLDER_DATA_URI}${TOKEN_MARK}${runId}-${index}~`
}

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Build the replacement `data:` URI, or `null` when the pieces are not what a
 * data URI may be made of. The content type of an inline part is text the
 * sender wrote, and the value is also written into CSS text (`url(...)`), so
 * anything outside the strict MIME / base64 alphabets is refused rather than
 * escaped; a null means "treat as a failed fetch".
 */
export function buildInlineImageDataUri(contentType: string | undefined, base64: string): string | null {
  const ct = (contentType || '').trim() || 'application/octet-stream'
  if (!MIME_RE.test(ct) || !BASE64_RE.test(base64)) return null
  return `data:${ct};base64,${base64}`
}

/**
 * Swap pending tokens for their data: URIs in a LIVE document (the iframe's).
 * Looks only where `replaceExternalImages` / `replaceCidImages` put tokens:
 * `src`, `srcset`, inline `style`, and `<style>` text. Returns the tokens that
 * were found and replaced. Idempotent: a token already swapped is simply not
 * found again.
 */
export function patchPendingImages(doc: Document, replacements: ReadonlyMap<string, string>): Set<string> {
  const applied = new Set<string>()
  if (replacements.size === 0 || !doc.querySelectorAll) return applied

  const swap = (value: string): string => {
    if (!value.includes(TOKEN_MARK)) return value
    let out = value
    for (const [token, uri] of replacements) {
      if (!out.includes(token)) continue
      out = out.split(token).join(uri)
      applied.add(token)
    }
    return out
  }

  const selector = `[src*="${TOKEN_MARK}"],[srcset*="${TOKEN_MARK}"],[style*="${TOKEN_MARK}"]`
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    for (const attr of ['src', 'srcset', 'style']) {
      const value = el.getAttribute(attr)
      if (!value) continue
      const next = swap(value)
      if (next !== value) el.setAttribute(attr, next)
    }
  }
  for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
    const text = styleEl.textContent
    if (!text) continue
    const next = swap(text)
    if (next !== text) styleEl.textContent = next
  }
  return applied
}
