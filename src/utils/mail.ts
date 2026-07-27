import DOMPurify from 'dompurify'
import { normalizeCid as _normalizeCid } from '@mailcopilot/core/mail'
import type { MailAddress, FolderRoles } from '../../packages/types'

/**
 * Determine whether the currently open message was sent by the current user.
 *
 * Security invariant (§3.3.C-uiaudit.22):
 * BCC recipients must never be shown for received mail. The gate requires
 * BOTH conditions to be true:
 *   1. Folder match — the message lives in the Sent folder of its own account
 *      (per-account `activeRoles`, not global `roles` to avoid cross-account
 *      scoping bugs).
 *   2. Identity match (defense-in-depth) — at least one From address
 *      matches a known identity of the active account. Without this second
 *      check, a spoofed / IMAP-rule-moved mail in Sent would pass the folder
 *      check alone and leak BCC.
 *
 * Safe defaults: returns `false` whenever any required input is absent or
 * ambiguous (active === null, env.from empty, no known identities).
 *
 * @param activeFolder - the folder path of the currently open message
 * @param activeRoles  - FolderRoles scoped to the message's account
 * @param envFrom      - envelope From addresses (MailAddress[]) of the message
 * @param accountIdentities - normalized (trimmed + lowercased) identity email
 *   list for the message's account; produced by `useAccountIdentities()`.
 */
export function deriveIsSentByMe(
  activeFolder: string | null | undefined,
  activeRoles: Pick<FolderRoles, 'sent'> | null | undefined,
  envFrom: MailAddress[] | null | undefined,
  accountIdentities: string[],
): boolean {
  // Gate 1: per-account Sent folder match.
  const sentFolder = activeRoles?.sent
  if (!activeFolder || !sentFolder || activeFolder !== sentFolder) return false

  // Gate 2: identity match (defense-in-depth against spoofed From in Sent).
  // No known identities → cannot confirm provenance → default false (safe).
  if (accountIdentities.length === 0) return false
  const from = envFrom ?? []
  if (from.length === 0) return false

  const fromLower = from
    .map(a => a.address?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a))

  return fromLower.some(addr => accountIdentities.includes(addr))
}

// Re-export pure functions from @mailcopilot/core — source of truth is packages/core/mail.ts
export {
  addrToString,
  addrListToString,
  extractEmails,
  uniqEmails,
  computeReplyRecipients,
  prefixSubject,
  quoteText,
  normalizeCid,
  replaceCidImages,
  formatBytes,
  formatSmartDate,
  getInitials,
  getAvatarColor,
  AVATAR_COLORS,
  getPaletteColor,
  sortFolders,
  getFolderRole,
  folderLabel,
} from '@mailcopilot/core/mail'

// --- DOM-dependent functions (renderer only) ---

/** Sanitize email HTML content for display */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // SVG <image> is an external-resource vector that bypasses <img> extractor;
    // forbid it outright. `base`/`meta` would alter relative-URL resolution.
    // <video>/<audio> carry poster/src attributes whose raw URLs the DOM-based
    // extractor does not rewrite — CSP `media-src 'none'` already blocks the
    // fetch, but we also want the invariant "no raw external URL in the
    // rendered iframe DOM" to hold for defence-in-depth, matching
    // Gmail/Outlook/Thunderbird which do not render HTML-email media.
    // DOMPurify drops child nodes of forbidden parents, so <source> inside
    // <video>/<audio> disappears as well; top-level <source> under <picture>
    // stays legit (see FORBID_TAGS comment — <source> is not listed).
    // SVG <feImage href> is a filter-primitive external-resource vector with
    // the same properties; drop it while leaving the enclosing <filter> alone.
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'image', 'video', 'audio', 'feImage'],
    // `background` is a legacy HTML attribute (<body background=>, <td background=>)
    // carrying an external URL that extractors historically missed. Drop it.
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'background'],
    ALLOW_DATA_ATTR: false,
    // data:/cid: needed for inline images. External resources are controlled by CSP in iframe.
    // Narrowed copy of DOMPurify's default IS_ALLOWED_URI: we deliberately allow
    // fewer schemes than upstream (no ftp/tel/callto/sms/xmpp/matrix). Keep the
    // hyphens escaped — `[a-z+.\-]` / `[^a-z+.\-:]` are sets of literal characters.
    // An unescaped `.-:` is parsed as the range 0x2E–0x3A (swallowing `/` and the
    // digits), which silently rejects relative URLs such as `path/page`. Upstream
    // carries the same escape + disable directive; `--report-unused-disable-directives`
    // makes dropping the escape fail lint, so the two stay in sync.
    // eslint-disable-next-line no-useless-escape
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|cid|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}

/** Safely extract text from HTML without loading external resources (tracking pixels, etc.) */
export function htmlToText(html: string): string {
  const safe = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'img', 'video', 'audio', 'source', 'link', 'style'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style', 'src', 'srcset', 'background'],
    ALLOW_DATA_ATTR: false,
  })
  const div = document.createElement('div')
  div.innerHTML = safe
  return (div.textContent || div.innerText || '').trim()
}

// --- External image handling (defence-in-depth against HTML email tracking / SSRF) ---

/**
 * 1x1 transparent PNG used to replace external image URLs that could not be
 * safely fetched through the main-process proxy. Inline data URI so the
 * renderer iframe never makes a network request under any CSP.
 */
export const BLOCKED_IMAGE_PLACEHOLDER_DATA_URI
  = 'data:image/svg+xml;utf8,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="transparent"/></svg>',
  )

/**
 * Detect whether HTML references external images that the security pipeline
 * will actually rewrite. Derived from {@link extractExternalImageUrls} on
 * sanitized input — this is authoritative (same path the pipeline uses) and
 * immune to every bypass class the DOM-based extractor already handles
 * (entity-encoded schemes, unquoted attributes, protocol-relative URLs,
 * CSS url(...) edge cases).
 *
 * Cost: one sanitize + DOMParser pass per call. Acceptable — email rendering
 * is not a hot loop, and {@link useMailIframeDoc} memoizes the per-message
 * result via the same extraction it uses to build the iframe srcdoc.
 */
export function hasExternalImagesInHtml(html: string): boolean {
  if (!html) return false
  return extractExternalImageUrls(sanitizeMailHtml(html)).length > 0
}

/**
 * Maximum number of external image URLs **fetched** per message. This caps the
 * main-process fetch budget against malicious payloads; it does NOT cap
 * extraction. Every extracted URL is always accounted for in the final DOM —
 * URLs past the budget are mapped to the inert placeholder, never left raw.
 */
export const MAX_EXTERNAL_IMAGE_URLS = 50

/**
 * Parse a possibly-untrusted HTML fragment into a detached `Document`.
 *
 * Using `DOMParser` (vs. `element.innerHTML =`) is the structural fix for the
 * extractor/replacer hardening (wave-3 of §3.10 P0):
 *   - HTML entities are decoded (`https&#58;//…` → `https://…`), so a bypass
 *     via entity-encoded scheme cannot survive back into the rendered DOM.
 *   - Attribute quoting is normalized (`src=https://…` and `src="https://…"`
 *     become identical once parsed); no "mandatory quote" regex hole.
 *   - Protocol-relative `//host/…` URLs are preserved as-seen in attribute
 *     values, letting us both fetch them (after normalizing to https) and
 *     replace the exact original token in the DOM.
 *   - Resource-bearing attributes unknown to a regex (`image[href]`,
 *     `[background]`, future additions) are enumerable via querySelector.
 *
 * The document is detached (not the live `document`), so no fetches fire.
 */
function parseHtmlDocument(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    // Fallback for unit tests running in bare node without a DOM. Callers
    // that need structural guarantees must run in jsdom / renderer.
    const doc = {
      body: { innerHTML: html, querySelectorAll: () => [] as Element[] },
      querySelectorAll: () => [] as Element[],
    } as unknown as Document
    return doc
  }
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html')
}

/**
 * Serialize a parsed document's body back to HTML. Sibling of
 * {@link parseHtmlDocument}; paired so the parse/serialize round-trip is a
 * single operation under our control.
 */
function serializeBody(doc: Document): string {
  return doc.body ? doc.body.innerHTML : ''
}

/**
 * Normalize a URL token as seen in the DOM to the canonical form used as a
 * fetch key and replacement-map key. Protocol-relative `//host/path` becomes
 * `https://host/path`. Returns null for anything that is not http/https after
 * normalization (cid:, data:, mailto:, about:, relative, etc).
 */
function normalizeExternalImageUrl(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  if (!/^https?:\/\//i.test(normalized)) return null
  return normalized
}

/**
 * Regex used to pull URLs out of inline CSS `url(...)` tokens.
 *
 * Three alternatives in one match:
 *   1. Double-quoted: `url("…")` — URL may contain any char except `"`,
 *      including `)` and whitespace. Captured in group 1.
 *   2. Single-quoted: `url('…')` — mirror of (1). Captured in group 2.
 *   3. Unquoted:      `url(…)` — URL terminates at `)` or whitespace.
 *      Captured in group 3.
 *
 * Matching one of three avoids the wave-1 bug where the character class
 * `[^'")]` excluded `)` even inside a quoted value, so `url('https://h/p)q')`
 * would not match even though CSS spec allows it (browsers accept it; trackers
 * can use it; CSP blocks the fetch but the URL survives in the DOM style
 * attribute without being rewritten). Only one of groups 1/2/3 is non-empty
 * per hit — callers read them with `m[1] ?? m[2] ?? m[3]`.
 *
 * IMPORTANT: callers must strip CSS comments from the input BEFORE running
 * this regex. See {@link stripCssComments}. The CSS spec permits block
 * comments (slash-star ... star-slash) between `url(` and the URL token, and
 * anywhere else in the stylesheet. Browsers parse and fetch such URLs.
 * Without pre-stripping, the regex sees `/` as the first char after
 * `url(\s*` and fails to match, leaving the URL raw in the rendered DOM
 * attribute — violating §3.10 invariant "no raw http(s) URL in rendered
 * iframe DOM".
 */
const CSS_URL_RE = /url\(\s*(?:"((?:https?:)?\/\/[^"]+)"|'((?:https?:)?\/\/[^']+)'|((?:https?:)?\/\/[^)\s]+))\s*\)/gi

/**
 * Strip CSS block comments (slash-star ... star-slash) from a CSS string.
 *
 * CSS spec allows comments anywhere whitespace is allowed, including between
 * `url(` and the URL token. Browsers parse and fetch `url(<comment>https://…)`.
 * Our DOM-based extractor relies on {@link CSS_URL_RE} which does not (and
 * cannot practically) parse CSS comments inline, so we remove them from the
 * CSS content before matching. The stripped form is also what gets written
 * back after replacement — preserving a comment in the middle of a URL would
 * leave the comment fragment in the attribute after rewrite and risk
 * confusing downstream CSS parsers.
 *
 * Scope: applied to element `style` attributes AND `<style>` element text
 * content. Both are walked in {@link extractExternalImageUrls} and
 * {@link replaceExternalImages}.
 */
function stripCssComments(css: string): string {
  // Non-greedy match — CSS comments do not nest, so `.*?` with the `s`-like
  // `[\s\S]` class is structurally safe. `u` flag kept off to match the rest
  // of the file's regex conventions.
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Collect external image URLs from a single DOM element, invoking the callback
 * for each (unnormalized) URL token found. Covers every resource-bearing
 * position the extractor supports:
 *   - `<img src>`, `<img srcset>`
 *   - `<source src>`, `<source srcset>` (inside `<picture>` / `<video>`)
 *   - `<input type="image" src>`
 *   - `[style]` attributes containing CSS `url(...)`
 *
 * Note: `<image>` SVG elements and `[background]` attributes are handled by
 * {@link sanitizeMailHtml}'s FORBID_TAGS/FORBID_ATTR; they do not survive
 * sanitization, so no explicit extraction is required — but callers that pass
 * RAW (unsanitized) HTML to {@link extractExternalImageUrls} rely on this
 * module's invariant that extraction happens AFTER sanitization. That
 * invariant is documented on {@link extractExternalImageUrls}.
 */
function forEachExternalUrlInElement(el: Element, cb: (rawToken: string) => void): void {
  const tag = el.tagName.toLowerCase()

  // src attribute on <img>, <source>, <input type=image>.
  if (tag === 'img' || tag === 'source'
    || (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image')) {
    const src = el.getAttribute('src')
    if (src) cb(src)
  }

  // srcset on <img> and <source>.
  if (tag === 'img' || tag === 'source') {
    const srcset = el.getAttribute('srcset')
    if (srcset) {
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0]
        if (url) cb(url)
      }
    }
  }

  // Inline style url(...) on any element. Covers background-image, content,
  // border-image, mask-image, list-style-image, etc. CSS comments are stripped
  // first — see {@link stripCssComments} for the bypass class this closes.
  const style = el.getAttribute('style')
  if (style) {
    const normalized = stripCssComments(style)
    let m: RegExpExecArray | null
    CSS_URL_RE.lastIndex = 0
    while ((m = CSS_URL_RE.exec(normalized))) {
      const url = m[1] ?? m[2] ?? m[3]
      if (url) cb(url)
    }
  }
}

/**
 * Extract external HTTP(S) image URLs from (preferably sanitized) email HTML.
 *
 * Implementation: parse HTML as a DOM, walk every resource-bearing element,
 * normalize protocol-relative URLs to https. This form is structurally
 * resilient to:
 *   - Unquoted attributes (`src=https://…`)
 *   - HTML-entity-encoded URLs (`src="https&#58;//…"`) — the parser decodes
 *     entities before we observe them.
 *   - Protocol-relative URLs (`src="//host/…"`) — normalized to https.
 *   - `<style>` blocks and any element carrying inline-style `url(...)`.
 *
 * All unique extracted URLs are returned — there is no extraction cap. The
 * {@link MAX_EXTERNAL_IMAGE_URLS} budget is applied by callers when deciding
 * how many to fetch via the main-process proxy; the full list is still used
 * by {@link buildExternalImageReplacementMap} so no URL ever remains raw.
 */
export function extractExternalImageUrls(html: string): string[] {
  const urls = new Set<string>()
  const s = html || ''
  if (!s) return []

  const doc = parseHtmlDocument(s)
  // Element tree walk — cheap even for thousand-element emails.
  const elements = doc.querySelectorAll ? doc.querySelectorAll('*') : []
  for (const el of Array.from(elements) as Element[]) {
    forEachExternalUrlInElement(el, (raw) => {
      const n = normalizeExternalImageUrl(raw)
      if (n) urls.add(n)
    })
  }

  // Also scan any surviving <style> element text content (CSS blocks). These
  // are rare in sanitized email (DOMPurify strips them unless explicitly
  // allowed) but defence-in-depth is cheap — a leftover @font-face or inline
  // rule with url(...) should still be captured. CSS block comments are
  // stripped first so a comment between `url(` and the URL token cannot
  // shield the URL from CSS_URL_RE.
  const styleEls = doc.querySelectorAll ? doc.querySelectorAll('style') : []
  for (const styleEl of Array.from(styleEls) as Element[]) {
    const text = styleEl.textContent || ''
    if (!text) continue
    const normalized = stripCssComments(text)
    if (!normalized) continue
    CSS_URL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CSS_URL_RE.exec(normalized))) {
      const raw = m[1] ?? m[2] ?? m[3]
      if (!raw) continue
      const n = normalizeExternalImageUrl(raw)
      if (n) urls.add(n)
    }
  }

  return [...urls]
}

/**
 * Replace external image URLs in HTML with values from the url→replacement map.
 * Used in two modes:
 *   - Successful fetch: replacement is a `data:image/...;base64,...` URI.
 *   - Failed / blocked fetch: replacement is {@link BLOCKED_IMAGE_PLACEHOLDER_DATA_URI}.
 *
 * Either way, the resulting HTML contains no raw external URLs in image-related
 * attributes — renderer iframe never attempts to fetch over the network.
 *
 * Implementation: parses the HTML via {@link parseHtmlDocument}, rewrites
 * attributes and inline-style url(...) tokens IN THE DOM, then serializes back.
 * This is structurally resilient to the same bypass classes as
 * {@link extractExternalImageUrls}: entities are decoded, attribute quoting is
 * normalized, and every element matching the selector is visited — there is
 * no alternation regex that could miss a token.
 */
export function replaceExternalImages(html: string, urlToReplacement: Record<string, string>): string {
  if (Object.keys(urlToReplacement).length === 0) return html
  const s = html || ''
  if (!s) return html

  // Case-insensitive lookup. Key: normalized external URL (https://…).
  const lowerMap = new Map<string, string>()
  for (const [url, replacement] of Object.entries(urlToReplacement)) {
    lowerMap.set(url.toLowerCase(), replacement)
  }

  const lookup = (rawToken: string): string | null => {
    const normalized = normalizeExternalImageUrl(rawToken)
    if (!normalized) return null
    return lowerMap.get(normalized.toLowerCase()) ?? null
  }

  const doc = parseHtmlDocument(s)
  if (!doc.querySelectorAll) return html

  const elements = doc.querySelectorAll('*')
  for (const el of Array.from(elements) as Element[]) {
    const tag = el.tagName.toLowerCase()

    // src on <img>, <source>, <input type=image>.
    if (tag === 'img' || tag === 'source'
      || (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image')) {
      const src = el.getAttribute('src')
      if (src) {
        const repl = lookup(src)
        if (repl !== null) el.setAttribute('src', repl)
      }
    }

    // srcset on <img>, <source> — parse, replace per-entry, preserve descriptors.
    if (tag === 'img' || tag === 'source') {
      const srcset = el.getAttribute('srcset')
      if (srcset) {
        const rewritten = srcset.split(',').map((entry) => {
          const trimmed = entry.trim()
          if (!trimmed) return entry
          // Split URL from descriptor — descriptor may be empty (single URL entry).
          const spaceIdx = trimmed.search(/\s/)
          const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
          const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx)
          const repl = lookup(url)
          if (repl === null) return entry
          return descriptor ? `${repl}${descriptor}` : repl
        }).join(',')
        el.setAttribute('srcset', rewritten)
      }
    }

    // style attribute — rewrite each url(...) token. CSS comments are
    // stripped FIRST so the stripped form is both matched and written back:
    // keeping a comment embedded inside a rewritten URL token would leave
    // tracker text (and potentially a comment-delimiter escape) in the
    // attribute, and the unstripped URL would fail to match at all —
    // leaving the raw http(s) token in the rendered DOM.
    const style = el.getAttribute('style')
    if (style && /url\(/i.test(style)) {
      const normalized = stripCssComments(style)
      CSS_URL_RE.lastIndex = 0
      const rewritten = normalized.replace(CSS_URL_RE, (match, dq?: string, sq?: string, uq?: string) => {
        const url = dq ?? sq ?? uq
        if (!url) return match
        const repl = lookup(url)
        if (repl === null) return match
        // Preserve the quote style of the original token. Data URIs cannot
        // contain raw `"` or `'` so simple concatenation is safe here.
        if (dq !== undefined) return `url("${repl}")`
        if (sq !== undefined) return `url('${repl}')`
        return `url(${repl})`
      })
      if (rewritten !== style) el.setAttribute('style', rewritten)
    }
  }

  // Also rewrite any <style> element text content. CSS comments are stripped
  // first (same rationale as the inline `style` attribute path).
  const styleEls = doc.querySelectorAll('style')
  for (const styleEl of Array.from(styleEls) as Element[]) {
    const text = styleEl.textContent || ''
    if (!text || !/url\(/i.test(text)) continue
    const normalized = stripCssComments(text)
    CSS_URL_RE.lastIndex = 0
    const rewritten = normalized.replace(CSS_URL_RE, (match, dq?: string, sq?: string, uq?: string) => {
      const url = dq ?? sq ?? uq
      if (!url) return match
      const repl = lookup(url)
      if (repl === null) return match
      if (dq !== undefined) return `url("${repl}")`
      if (sq !== undefined) return `url('${repl}')`
      return `url(${repl})`
    })
    if (rewritten !== text) styleEl.textContent = rewritten
  }

  return serializeBody(doc)
}

/**
 * Build the full replacement map for extracted URLs: prefer inlined data URI,
 * fall back to the blocked-image placeholder. Guarantees every extracted URL
 * has a mapping so {@link replaceExternalImages} never leaves raw HTTP(S) in
 * image-related DOM positions.
 */
export function buildExternalImageReplacementMap(
  extractedUrls: string[],
  inlined: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const url of extractedUrls) {
    out[url] = inlined[url] || BLOCKED_IMAGE_PLACEHOLDER_DATA_URI
  }
  return out
}

/**
 * Build the iframe srcdoc with a hardened CSP.
 *
 * Security invariant: `img-src` is ALWAYS `'self' data: cid:` regardless of the
 * user's "show external images" preference. External images are inlined as
 * `data:` URIs by the main-process proxy before being injected into the iframe,
 * so the iframe itself never needs — and is never allowed — to fetch over the
 * network. This closes the classic HTML-email tracking/SSRF vector even if
 * `replaceExternalImages` misses an extractor case.
 */
export function buildMailIframeSrcDoc(bodyHtml: string, opts: { darkMode: boolean }): string {
  const csp = [
    `default-src 'none'`,
    // Hard invariant — no http/https img-src under any setting.
    `img-src 'self' data: cid:`,
    `style-src 'unsafe-inline'`,
    `script-src 'none'`,
    `font-src 'none'`,
    `media-src 'none'`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ')

  // Explicit body background (#eaefff) ensures uniform coverage after invert+hue-rotate.
  // html background (#0b1020) matches app dark bg, so the gap between body and viewport
  // stays dark. Without explicit body bg, transparent body lets html show through unfiltered.
  const darkCss = opts.darkMode
    ? ' html{background:#0b1020;min-height:100%} body{background-color:#eaefff;filter:invert(1) hue-rotate(180deg);min-height:100vh} img,video,picture,svg,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)}'
    : ''

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    // Prevent sending Referer header — srcdoc iframes send opaque/file:// origin
    // as Referer, which many CDN/tracking servers reject, breaking external images.
    '<meta name="referrer" content="no-referrer" />',
    // Basic reset so emails look cleaner (and do not break layout).
    `<style>html,body{margin:0;padding:0} body{font:14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; padding: 12px; overflow:hidden} html{overflow-y:auto;scrollbar-width:thin;scrollbar-color:${opts.darkMode ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.35)'} transparent}${darkCss}</style>`,
    '</head>',
    '<body>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('')
}

/** Extract `cid:<id>` references from email HTML. Returns unique normalized CIDs. */
export function extractCidsFromHtml(html: string): string[] {
  const s = html || ''
  const res: string[] = []
  const re = /cid:([^'">)\s]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const cid = _normalizeCid(m[1] || '')
    if (cid) res.push(cid)
  }
  return Array.from(new Set(res))
}
