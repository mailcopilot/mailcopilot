import { useEffect, useState } from 'react'
import type { AttachmentMeta, MailSummary, MessageDetails } from '../../packages/net/types'
import {
  sanitizeMailHtml,
  normalizeCid,
  replaceCidImages,
  extractCidsFromHtml,
  extractExternalImageUrls,
  replaceExternalImages,
  buildExternalImageReplacementMap,
  buildMailIframeSrcDoc,
  MAX_EXTERNAL_IMAGE_URLS,
} from '../utils/mail'
import { rewriteMailHtmlLinks } from '../utils/mailLinks'
import { collapseQuotedText } from '@mailcopilot/core'

/**
 * Parameters for {@link useMailIframeDoc}.
 *
 * All fields are part of the effect's dependency array — changing any of them
 * triggers a full pipeline rerun and cancels any in-flight fetch for the
 * previous email (stale-response guard).
 */
export interface UseMailIframeDocParams {
  /** Currently selected message, or `null` when nothing is active. */
  active: MailSummary | null
  /** Full message details (html/text/attachments) for the active message. */
  details: MessageDetails | null
  /** User preference: always auto-load external images without prompting. */
  alwaysLoadImages: boolean
  /**
   * Per-message override: user clicked "Show images" on the current email.
   * Resets to `alwaysLoadImages` when `active` changes — that reset lives in
   * App.tsx (not the hook) because it involves other UI state.
   */
  showExternalImages: boolean
  /** User preference: apply dark-mode invert filter to email bodies. */
  darkModeEmails: boolean
  /** App theme; combined with `darkModeEmails` to decide filter CSS. */
  theme: 'light' | 'dark'
  /**
   * Localised label for the quoted-text collapse toggle, e.g.
   * `t('mail.thread.showQuoted')`.  Passed through to
   * {@link collapseQuotedText} so `packages/core` stays i18n-free.
   */
  quotedTextLabel: string
}

export interface UseMailIframeDocReturn {
  /**
   * Iframe srcdoc string, or `null` while computing. `null` is also returned
   * when the active email has no html body (caller falls back to text view).
   *
   * The srcdoc is gated on completion of the external-image pipeline — no
   * intermediate setMailIframeDoc call exposes a raw http(s) URL to the DOM.
   */
  doc: string | null
  /**
   * Whether the sanitized email HTML contains any external image references
   * that the security pipeline will rewrite. Drives the "images blocked"
   * privacy banner. Derived from the same extractor pass that builds
   * {@link doc}, so no double-parse.
   */
  hasExternalImages: boolean
}

/**
 * Build a safe srcdoc for an email message, resolving external images through
 * the main-process SSRF-safe proxy. Extracted from App.tsx.
 *
 * NOTE: this used to point at `docs/ARCHITECTURE.md` §3.10, which does not
 * exist — the rendering pipeline was never written up there, so the rationale
 * lives in the step comments below and nowhere else. See BACKLOG §2.65 for the
 * open question of whether "no raw external URL in the iframe DOM" is a real
 * security invariant or best-effort: MailWindow.tsx does not honour it today.
 *
 * Pipeline (matches App.tsx wave-3 implementation):
 *   1. sanitize (DOMPurify) — drops script/iframe/image/media tags, on* attrs,
 *      decodes HTML entities in attribute values.
 *   2. replace cid: with data: via main-process inline-attachment fetch.
 *   3. extract every external http(s) URL from img/srcset/input/style/<style>.
 *   4. fetch a budget-capped subset via main-process proxy (inlined as
 *      `data:image/...;base64,...`).
 *   5. build replacement map — successes get their data URI, failures and
 *      over-budget URLs map to {@link BLOCKED_IMAGE_PLACEHOLDER_DATA_URI}.
 *   6. replace all mapped URLs in the DOM — iframe never receives a raw
 *      http(s) URL in any image-bearing position.
 *   7. rewrite mail links to the routed-mail scheme so click handling goes
 *      through the link prompt.
 *   8. collapse quoted text (blockquotes, Outlook/Gmail separators) using
 *      native `<details>`/`<summary>` — no JS injection in iframe.
 *   9. wrap in hardened srcdoc with `img-src 'self' data: cid:` CSP.
 *
 * Cancellation: each effect run sets up a `cancelled` flag. When the effect
 * reruns (email switch, preference change) the previous closure aborts
 * before calling setState, so stale fetch results cannot clobber a newer
 * message.
 */
/**
 * Promote lazy-load attributes (`data-src`, `data-original`, `data-srcset`)
 * onto the real `src` / `srcset` positions that the downstream pipeline
 * understands. Runs BEFORE sanitize — DOMPurify is configured with
 * `ALLOW_DATA_ATTR: false`, so `data-*` values would otherwise be stripped
 * before the extractor observes them, and lazy-loaded tracking pixels /
 * images would neither appear in the banner nor be rewritten by the
 * replacement map.
 *
 * Restricted to image-bearing elements (`<img>`, `<source>`). Promoting on
 * arbitrary tags opened a smuggling path: `<a data-src="https://smuggle/x">`
 * would become `<a src="https://smuggle/x">`, DOMPurify's default
 * `ALLOWED_ATTR` accepts `src` globally and does NOT strip it from `<a>`,
 * and the external-image extractor only scans `<img>/<source>/<input
 * type=image>` — raw URL survives into the iframe DOM with
 * `hasExternalImages=false` (no banner, no rewrite). Same shape applies to
 * `<div data-src>`, `<input type=text data-src>`, etc. Real-world lazy-load
 * libraries target `<img>` / `<source>` only (picture element).
 *
 * Overwrite rule: when BOTH `src` and `data-src` are present, `data-src` wins
 * on `<img>/<source>`. This is the common lazy-load idiom — `src` holds a
 * 1×1 placeholder GIF (or `data:` URI, or `cid:`), `data-src` holds the real
 * URL. The previous "src absent" rule silently lost the real URL whenever a
 * placeholder was present, making the image unreachable (extractor saw only
 * the placeholder, `hasExternalImages=false`, user had no opt-in path). The
 * edge case of `<img src="real1.jpg" data-src="real2.jpg">` loses real1, but
 * that shape is not a lazy-load convention and is not observed in the wild.
 *
 * Parsing uses DOMParser (jsdom in tests, renderer DOM in production) so
 * HTML entities, attribute quoting, and protocol-relative URLs are handled
 * identically to the rest of the pipeline. No raw network fetch fires —
 * the detached document is serialized back to a string.
 */
function promoteLazyLoadAttrs(html: string): string {
  if (!html) return html
  // Cheap pre-check: if none of the lazy-load attribute names appear as raw
  // text, nothing to do. Case-insensitive to match HTML attribute semantics.
  if (!/\bdata-(?:src|original|srcset)\s*=/i.test(html)) return html

  if (typeof DOMParser === 'undefined') {
    // Fallback for environments without a DOM (bare node). Regex is a best
    // effort: since we can't tag-discriminate without a parser, we keep the
    // legacy behaviour of rewriting attribute names globally. Renderer /
    // jsdom paths use the DOM-aware branch below which is the production
    // target for this file.
    return html
      .replace(/\sdata-src=/gi, ' src=')
      .replace(/\sdata-original=/gi, ' src=')
      .replace(/\sdata-srcset=/gi, ' srcset=')
  }

  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  )
  // Scope to image-bearing elements only. `<a>`, `<div>`, `<input>` (any
  // type) are intentionally excluded — see JSDoc above for the smuggling
  // rationale.
  for (const el of Array.from(doc.querySelectorAll('img, source')) as Element[]) {
    const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-original')
    if (dataSrc) {
      // Overwrite any placeholder `src`. data-src is the real URL by
      // convention; the placeholder was never meant to be the final image.
      el.setAttribute('src', dataSrc)
    }
    el.removeAttribute('data-src')
    el.removeAttribute('data-original')

    const dataSrcset = el.getAttribute('data-srcset')
    if (dataSrcset) {
      el.setAttribute('srcset', dataSrcset)
    }
    el.removeAttribute('data-srcset')
  }
  return doc.body ? doc.body.innerHTML : html
}

export function useMailIframeDoc(params: UseMailIframeDocParams): UseMailIframeDocReturn {
  const { active, details, alwaysLoadImages, showExternalImages, darkModeEmails, theme, quotedTextLabel } = params

  const [doc, setDoc] = useState<string | null>(null)
  const [hasExternalImages, setHasExternalImages] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Reset state at effect start so stale UI (previous email's srcdoc and
    // banner) cannot show while the new email resolves.
    setDoc(null)
    setHasExternalImages(false)

    if (!active || !details?.html) return () => { cancelled = true }

    const ctx = { accountId: active.accountId, folder: active.folder, uid: active.uid }
    const rawHtml = details.html || ''
    const allowExternal = alwaysLoadImages || showExternalImages
    // Lazy-load attributes (data-src, data-original, data-srcset) are
    // normalized to their real counterparts UNCONDITIONALLY — regardless of
    // `allowExternal`. Rationale:
    //   1. In the blocked state (`allowExternal=false`) the extractor needs
    //      to see the real URL so `hasExternalImages` becomes true and the
    //      "Show images" banner appears. Otherwise the user faces a
    //      chicken-and-egg: no banner → no way to opt in.
    //   2. The privacy invariant still holds in the blocked state. Every
    //      extracted URL flows through buildExternalImageReplacementMap →
    //      placeholder data: URI, so the rendered iframe DOM never contains
    //      a raw http(s) token regardless of whether the URL came from
    //      `src=` or a promoted `data-src=`.
    //   3. DOMPurify `ALLOW_DATA_ATTR: false` strips `data-*` during
    //      sanitize, so without this pre-normalization the extractor would
    //      see nothing and the banner would never appear.
    // Promotion is DOM-aware: a `data-src` / `data-original` value is
    // promoted only when the element has no existing `src`. This avoids
    // creating duplicate `src=` attributes (non-deterministic parser
    // behavior) when a placeholder GIF is already present in `src`.
    const normalizedRawHtml = promoteLazyLoadAttrs(rawHtml)

    const darkMode = theme === 'dark' && darkModeEmails

    /**
     * Pre-fetch external images via the main-process proxy and return a
     * URL→dataURI map. Only fetches a subset (budget-capped); every URL NOT
     * in the returned map is later replaced by the inert placeholder so no
     * raw http(s) URL survives into the iframe DOM.
     */
    const fetchExternal = async (urls: string[]): Promise<Record<string, string>> => {
      if (!allowExternal || urls.length === 0) return {}

      // Budget cap: refuse to issue more than MAX_EXTERNAL_IMAGE_URLS fetches
      // per message. This caps network concurrency; URLs past the budget are
      // passed through to the placeholder path, not left raw.
      const budget = urls.slice(0, MAX_EXTERNAL_IMAGE_URLS)

      const urlToDataUri: Record<string, string> = {}
      // Fetch in batches of 6 to avoid overwhelming the main process.
      const BATCH = 6
      for (let i = 0; i < budget.length && !cancelled; i += BATCH) {
        const batch = budget.slice(i, i + BATCH)
        await Promise.all(batch.map(async (url) => {
          try {
            const resp = await window.api.invoke('net:fetchExternalImage', url) as
              | { ok: true; contentBase64: string; contentType: string }
              | { ok: false; error?: string }
            if (resp?.ok) urlToDataUri[url] = `data:${resp.contentType};base64,${resp.contentBase64}`
            // On !ok, the URL is NOT added to urlToDataUri. buildExternalImageReplacementMap
            // then substitutes BLOCKED_IMAGE_PLACEHOLDER_DATA_URI below — raw URL never
            // survives into the iframe DOM.
          } catch {
            // Network/IPC failure — fall through to placeholder replacement.
          }
        }))
      }
      return urlToDataUri
    }

    const inlineAtts = (details.attachments || [])
      .filter(a => Boolean(a.cid) && (a.disposition || '').toLowerCase() === 'inline')
      .slice(0, 25)

    const hasCids = normalizedRawHtml.toLowerCase().includes('cid:') && inlineAtts.length > 0

    void (async () => {
      // Sanitize FIRST. DOMPurify:
      //   - drops dangerous tags (script, iframe, <image>, <base>, <meta>,
      //     <video>, <audio>, <feImage>)
      //   - drops dangerous attrs (on*, background)
      //   - decodes HTML entities in attribute values, normalizing the attack
      //     surface for the subsequent DOM-based extractor/replacer.
      // Running sanitize AFTER replace would re-introduce decoded-entity
      // bypasses (e.g. `src="https&#58;//…"` would survive the extractor and
      // then be decoded by DOMPurify straight into the iframe DOM).
      let html = sanitizeMailHtml(normalizedRawHtml)

      // Replace CID images with data: URIs. `replaceCidImages` targets
      // `cid:<id>` tokens regardless of attribute context and is not a source
      // of external-URL leakage.
      if (hasCids) {
        const inlineByCid = new Map<string, AttachmentMeta>()
        for (const a of inlineAtts) {
          const cid = a.cid ? normalizeCid(a.cid) : ''
          if (cid && !inlineByCid.has(cid)) inlineByCid.set(cid, a)
        }
        const cids = extractCidsFromHtml(html).slice(0, 25)
        const cidToDataUri: Record<string, string> = {}
        await Promise.all(cids.map(async (cid) => {
          const att = inlineByCid.get(cid)
          if (!att) return
          try {
            const resp = await window.api.invoke('net:attachmentBase64', ctx.accountId, ctx.folder, ctx.uid, att.part) as
              | { ok: true; contentBase64: string; contentType?: string }
              | { ok: false; error?: string }
            if (!resp || !resp.ok) return
            const ct = (att.contentType || resp.contentType || 'application/octet-stream').trim() || 'application/octet-stream'
            cidToDataUri[cid] = `data:${ct};base64,${resp.contentBase64}`
          } catch { /* ignore */ }
        }))
        html = replaceCidImages(html, cidToDataUri)
      }

      // Extract EVERY external URL up-front — we must account for all of them
      // in the final DOM whether the fetch succeeds, fails, or is skipped
      // (user has not allowed external images). Unlike the wave-1 cap, this
      // list is uncapped at extraction time; {@link MAX_EXTERNAL_IMAGE_URLS}
      // applies only to the fetch budget inside fetchExternal().
      const extractedUrls = extractExternalImageUrls(html)

      // Banner derivation — authoritative (driven by the same extractor the
      // security pipeline uses), no double-parse. Set before awaiting fetch
      // so the banner appears immediately while images resolve.
      if (!cancelled) setHasExternalImages(extractedUrls.length > 0)

      // Pre-fetch a budgeted subset via the main-process proxy. Returns only
      // URLs that fetched successfully; everything else (unfetched due to
      // budget, failed fetch, or allowExternal=false) is replaced with the
      // inert placeholder below.
      const inlinedMap = await fetchExternal(extractedUrls)
      if (cancelled) return

      // Build replacement map covering ALL extracted URLs: successful fetch →
      // inlined data URI, everything else → inert placeholder data URI. The
      // placeholder path also fires when allowExternal=false — the iframe CSP
      // would block the request anyway, but explicit replacement guarantees
      // the iframe DOM never contains a raw http(s) URL in any image-bearing
      // position.
      const replacementMap = buildExternalImageReplacementMap(extractedUrls, inlinedMap)
      const finalHtml = replaceExternalImages(html, replacementMap)

      const linkedHtml = rewriteMailHtmlLinks(finalHtml)
      // Collapse quoted text (blockquotes, Outlook separators) using native
      // <details>/<summary> so no JS injection is required in the iframe.
      const safeBody = collapseQuotedText(linkedHtml, 'html', { label: quotedTextLabel })
      const out = buildMailIframeSrcDoc(safeBody, { darkMode })
      if (!cancelled) setDoc(out)
    })()

    return () => { cancelled = true }
    // details.attachments / details.html are the granular deps — anything
    // else inside `details` (text body, flags, envelope) does not affect the
    // srcdoc. Keeping the dep list tight avoids redundant pipeline reruns on
    // unrelated detail updates.
  }, [active, alwaysLoadImages, darkModeEmails, details?.attachments, details?.html, quotedTextLabel, showExternalImages, theme])

  return { doc, hasExternalImages }
}
