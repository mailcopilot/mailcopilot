import { normalizeExternalUrl, buildRoutedMailLink } from '@mailcopilot/core/mailLinks'

// Re-export pure functions from @mailcopilot/core — source of truth is packages/core/mailLinks.ts
export { normalizeExternalUrl, buildRoutedMailLink, isRoutedMailLink } from '@mailcopilot/core/mailLinks'

// --- DOM-dependent functions (renderer only) ---

/**
 * Rewrites links in HTML for safe click interception from main (no JS inside iframe).
 *
 * Covers every navigable href-bearing position the renderer iframe can produce:
 *   - `<a href>`       — primary anchor links
 *   - `<area href>`    — image-map links (codex-security-review HIGH B4 gap)
 *
 * Why `<area>` is handled, and what has changed since. AT DISCOVERY,
 * `querySelectorAll('a[href]')` alone missed `<map>` / `<area>` elements, so a
 * raw http(s) href stayed in the rendered DOM; `will-frame-navigate` observed
 * it and the main-process fallback in `configureExternalLinks` handed it
 * straight to `shell.openExternal` — no phishing prompt anywhere on that path.
 * TODAY that second half no longer holds: a link that escaped this rewriter
 * comes back from `decideMailLinkAction` as `{ kind: 'raw', payload: { …,
 * unsafeBypass: true } }`, and `useMailLinkClick` turns `unsafeBypass` into a
 * forced prompt, so the fallback warns rather than opening silently.
 *
 * The rewrite here is therefore no longer the only thing between an image-map
 * link and the browser, but it is still the FIRST one: it is what puts the
 * destination in the element's tooltip, and what lets the click arrive at
 * `useMailLinkClick` as an ordinary routed link. Dropping `<area>` again would
 * demote every image-map link to the always-warn fallback — a prompt on every
 * legitimate one, which is how prompts stop being read. Keep both layers.
 *
 * Defense-in-depth: even if a `<base href>` tag somehow survives
 * {@link sanitizeMailHtml} (which forbids it via FORBID_TAGS), this rewriter
 * also strips any `<base>` it sees so relative URLs cannot be silently
 * resolved against an attacker-supplied origin in the iframe DOM.
 */
export function rewriteMailHtmlLinks(html: string): string {
  // In unit tests, utils may be imported in Node without DOM.
  if (typeof document === 'undefined' || !document.implementation?.createHTMLDocument) return html

  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = html || ''

  // Defense-in-depth: drop any surviving <base> from the body so that relative
  // URLs in <a href>/<area href> cannot resolve against an attacker-controlled
  // origin if sanitization is somehow bypassed upstream.
  for (const baseEl of Array.from(doc.querySelectorAll('base'))) {
    baseEl.remove()
  }

  const anchors = Array.from(doc.querySelectorAll('a[href]'))
  const areas = Array.from(doc.querySelectorAll('area[href]'))
  const linkElements: Element[] = [...anchors, ...areas]

  for (const el of linkElements) {
    const hrefRaw = (el.getAttribute('href') || '').trim()
    if (!hrefRaw || hrefRaw.startsWith('#')) continue

    const normalized = normalizeExternalUrl(hrefRaw)
    if (!normalized) continue

    // Tooltip: show the actual domain/protocol.
    try {
      const u = new URL(normalized)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        el.setAttribute('title', `${u.protocol}//${u.host}`)
      } else if (u.protocol === 'mailto:') {
        el.setAttribute('title', normalized)
      }
    } catch {
      // ignore
    }

    // <area> has no textContent in the layout sense (its visible representation
    // is the underlying image region); the routed link's `text` field is used
    // for phishing-mismatch detection and falls through to "" → renderer treats
    // empty text as "no displayed-host claim", so no false-positive mismatch.
    el.setAttribute('href', buildRoutedMailLink(normalized, (el.textContent || '').trim()))
    el.setAttribute('target', '_top')
    el.setAttribute('rel', 'noreferrer noopener')
  }

  return doc.body.innerHTML
}
