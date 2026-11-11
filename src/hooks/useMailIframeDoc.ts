import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { AttachmentMeta, MailSummary, MessageDetails } from '../../packages/net/types'
import {
  sanitizeMailHtml,
  replaceCidImages,
  blockUnresolvedCidImages,
  extractExternalImageUrls,
  replaceExternalImages,
  BLOCKED_IMAGE_PLACEHOLDER_DATA_URI,
  buildMailIframeSrcDoc,
  MAX_EXTERNAL_IMAGE_URLS,
} from '../utils/mail'
import { rewriteMailHtmlLinks } from '../utils/mailLinks'
import { buildInlineImageDataUri, newPendingRunId, patchPendingImages, pendingImageToken } from '../utils/pendingImages'
import { collapseQuotedText } from '@mailcopilot/core'
import {
  selectCidPartsToInline,
  selectPartsToHide,
  type ResolvedCidPart,
} from '@mailcopilot/core/cidRefs'

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
  /**
   * The mounted mail iframe. Images that arrive after the body was handed to
   * the iframe are written into its LIVE document (§2.308), so the hook needs
   * the element; `null` until it mounts.
   */
  iframeRef: RefObject<HTMLIFrameElement | null>
}

export interface UseMailIframeDocReturn {
  /**
   * Iframe srcdoc string, or `null` while computing. `null` is also returned
   * when the active email has no html body (caller falls back to text view).
   *
   * The srcdoc is available as soon as the html is sanitized: inline (CID) and
   * allowed external images are inert placeholders in it and are swapped for the
   * real `data:` URIs in the live iframe document as they arrive. At no moment
   * does any document expose a raw http(s) URL.
   */
  doc: string | null
  /**
   * Whether the sanitized email HTML contains any external image references
   * that the security pipeline will rewrite. Drives the "images blocked"
   * privacy banner. Derived from the same extractor pass that builds
   * {@link doc}, so no double-parse.
   */
  hasExternalImages: boolean
  /**
   * The attachments whose chip the list drops — nothing more is claimed. A part
   * is in here only when all four §2.128 conditions hold: it carries a `cid`,
   * its disposition is explicitly `inline`, that `cid` is written in an
   * `<img src>` / `<input type=image src>` position of the sanitized body, and
   * this hook fetched its bytes and substituted them into the body.
   *
   * Everything else keeps its chip, including a part the body draws from a CSS
   * background — one redundant chip is cheap, an unreachable file is not.
   *
   * Grows as the images arrive (§2.308): empty when the body first shows, so
   * the only transition is shown → hidden, one part at a time, each after its
   * image has been written into the live document. A fetch that fails or never
   * answers leaves the chip in place instead of hiding a file the body could
   * not draw either.
   */
  hiddenAttachments: AttachmentMeta[]
  /**
   * Wire to the iframe's `onLoad`. A (re)loaded document starts with
   * placeholders again; this re-applies every image that has already arrived.
   */
  onIframeLoad: () => void
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
 * Pipeline:
 *   1. sanitize (DOMPurify) — drops script/iframe/image/media tags, on* attrs,
 *      decodes HTML entities in attribute values.
 *   2. replace cid: references and the external image URLs inside the fetch
 *      budget with pending tokens (inert placeholder + unique fragment); every
 *      other external URL becomes the plain placeholder. The iframe never
 *      receives a raw http(s) URL in any image-bearing position, and a `cid:`
 *      reference with no pending token (no such part, or one past the inlining
 *      ceiling) becomes the same plain placeholder (`blockUnresolvedCidImages`).
 *   3. rewrite mail links, collapse quoted text, wrap in a hardened srcdoc with
 *      the `img-src 'self' data: cid:` CSP — and hand it to the iframe NOW.
 *   4. in the background, fetch the inline attachments and the budgeted
 *      external images (via the main-process SSRF-safe proxy); as each one
 *      arrives its token is swapped for the real `data:` URI in the LIVE iframe
 *      document (see utils/pendingImages.ts). The text never waits for them.
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
  const { active, details, alwaysLoadImages, showExternalImages, darkModeEmails, theme, quotedTextLabel, iframeRef } = params

  const [doc, setDoc] = useState<string | null>(null)
  const [hasExternalImages, setHasExternalImages] = useState(false)
  const [hiddenAttachments, setHiddenAttachments] = useState<AttachmentMeta[]>([])

  /**
   * The html the iframe will show, up to the point where it stops depending on
   * IPC: lazy-load promotion + sanitize. Both steps are synchronous, so the
   * inline-part decision below is available during render.
   *
   * It is deliberately the SANITIZED html: a `cid:` position DOMPurify removes
   * (`<td background>`, a child of a forbidden element, …) is not drawn, and
   * must therefore not be able to retire an attachment either.
   */
  const preparedHtml = useMemo(() => {
    const raw = details?.html || ''
    return raw ? sanitizeMailHtml(promoteLazyLoadAttrs(raw)) : ''
  }, [details?.html])

  /**
   * The parts to fetch and substitute into the body. Broad on purpose — see
   * `packages/core/cidRefs.ts`: this is the rendering question, and answering
   * it too narrowly stops drawing images that render today. Which chips
   * disappear is a different, much stricter question, answered after the fetch.
   */
  const cidPartsToInline = useMemo(
    () => selectCidPartsToInline(details?.attachments, preparedHtml),
    [details?.attachments, preparedHtml],
  )

  const liveRun = useRef<{ flush: () => void } | null>(null)
  const onIframeLoad = useCallback(() => { liveRun.current?.flush() }, [])

  useEffect(() => {
    let cancelled = false
    // Reset state at effect start so stale UI (previous email's srcdoc and
    // banner) cannot show while the new email resolves. Chips reset to "all
    // shown": nothing has been substituted yet, so nothing may be hidden yet.
    setDoc(null)
    setHasExternalImages(false)
    setHiddenAttachments([])

    if (!active || !details?.html) return () => { cancelled = true }

    const ctx = { accountId: active.accountId, folder: active.folder, uid: active.uid }
    const allowExternal = alwaysLoadImages || showExternalImages
    // `preparedHtml` (above) already ran lazy-load promotion and sanitize.
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

    const darkMode = theme === 'dark' && darkModeEmails

    // Pending tokens (see utils/pendingImages.ts): minted per run with a random
    // id the sender can not know. Bytes of an earlier run are kept out of this
    // document by `cancelled`, by `resolved` being per run, and by the iframe
    // remount per message — not by the token.
    const runId = newPendingRunId()
    let nextToken = 0
    /** token → the real data: URI, once the bytes have arrived. */
    const resolved = new Map<string, string>()
    /** tokens already written into a live document (hide-chip decision, below). */
    const applied = new Set<string>()
    /** token → the inline part it stands for (keyed by token: a Content-ID is sender text). */
    const cidByToken = new Map<string, ResolvedCidPart<AttachmentMeta>>()

    /**
     * Write every image that has arrived into the iframe's live document, then
     * update the chip row for the parts that actually landed. Safe to call at
     * any time and any number of times: with no iframe, or one that has not
     * loaded this srcdoc yet, nothing matches and the next call (the iframe's
     * `onLoad`, or the next arrival) does the work.
     */
    const flush = () => {
      if (cancelled) return
      const liveDoc = iframeRef.current?.contentDocument
      if (!liveDoc) return
      let grew = false
      for (const token of patchPendingImages(liveDoc, resolved)) {
        if (!applied.has(token)) { applied.add(token); grew = true }
      }
      if (!grew) return
      // §2.128 condition 4 is read off what was really written into the body.
      const substituted = [...applied].flatMap(t => cidByToken.get(t) ?? [])
      setHiddenAttachments(selectPartsToHide(substituted, preparedHtml))
    }
    liveRun.current = { flush }

    // ---- Phase 1: the body, immediately. No network wait of any kind. ----
    //
    // Sanitize already happened in `preparedHtml` — BEFORE any replacement.
    // DOMPurify:
    //   - drops dangerous tags (script, iframe, <image>, <base>, <meta>,
    //     <video>, <audio>, <feImage>)
    //   - drops dangerous attrs (on*, background)
    //   - decodes HTML entities in attribute values, normalizing the attack
    //     surface for the subsequent DOM-based extractor/replacer.
    // Running sanitize AFTER replace would re-introduce decoded-entity
    // bypasses (e.g. `src="https&#58;//…"` would survive the extractor and
    // then be decoded by DOMPurify straight into the iframe DOM).
    let html = preparedHtml

    // Inline (CID) images: each gets its own pending token; the bytes are
    // fetched in phase 2. `replaceCidImages` targets `cid:<id>` tokens
    // regardless of attribute context and is not a source of external-URL
    // leakage. A `Map`, not an object literal: the key is the sender's
    // `Content-ID`, and an object's key space is not made of data
    // (`obj['__proto__'] = uri` creates no own property, so the substitution
    // would silently not happen).
    const cidToToken = new Map<string, string>()
    for (const entry of cidPartsToInline) {
      const token = pendingImageToken(runId, nextToken++)
      cidToToken.set(entry.cid, token)
      cidByToken.set(token, entry)
    }
    if (cidToToken.size > 0) html = replaceCidImages(html, cidToToken)

    // Extract EVERY external URL up-front — we must account for all of them
    // in the final DOM whether the fetch succeeds, fails, or is skipped
    // (user has not allowed external images). Unlike the wave-1 cap, this
    // list is uncapped at extraction time; {@link MAX_EXTERNAL_IMAGE_URLS}
    // applies only to the fetch budget.
    const extractedUrls = extractExternalImageUrls(html)

    // Banner derivation — authoritative (driven by the same extractor the
    // security pipeline uses), no double-parse.
    setHasExternalImages(extractedUrls.length > 0)

    // Every extracted URL maps to the inert placeholder, so the iframe DOM
    // never contains a raw http(s) URL in any image-bearing position. Those
    // inside the fetch budget (a subset, via the main-process proxy, and only
    // when the user allowed external images) get a pending token instead:
    // visually the same placeholder, but swappable once the bytes arrive.
    const fetchUrls = allowExternal ? extractedUrls.slice(0, MAX_EXTERNAL_IMAGE_URLS) : []
    const externalByToken = new Map<string, string>()
    const replacementMap: Record<string, string> = {}
    for (const url of extractedUrls) replacementMap[url] = BLOCKED_IMAGE_PLACEHOLDER_DATA_URI
    for (const url of fetchUrls) {
      const token = pendingImageToken(runId, nextToken++)
      externalByToken.set(token, url)
      replacementMap[url] = token
    }
    // A `cid:` reference no pending token answers for (no such part, or one past the
    // inlining ceiling, so nothing is fetched for it) must not reach the iframe as `cid:`:
    // the browser would draw its broken-image icon. It ends as the same placeholder a
    // blocked image does; its chip stays. Runs AFTER the external pass, never before: the
    // placeholder carries a `"`, and inside a double-quoted external
    // `url("//host … url(cid:x) …")` it would end that token early and hide the URL from
    // the extractor.
    const finalHtml = blockUnresolvedCidImages(replaceExternalImages(html, replacementMap))

    const linkedHtml = rewriteMailHtmlLinks(finalHtml)
    // Collapse quoted text (blockquotes, Outlook separators) using native
    // <details>/<summary> so no JS injection is required in the iframe.
    const safeBody = collapseQuotedText(linkedHtml, 'html', { label: quotedTextLabel })
    setDoc(buildMailIframeSrcDoc(safeBody, { darkMode }))

    // ---- Phase 2: images, in the background, each applied as it arrives. ----
    const arrived = (token: string, dataUri: string | null) => {
      if (cancelled || !dataUri) return
      resolved.set(token, dataUri)
      flush()
    }

    void (async () => {
      await Promise.all([
        // Inline attachments, all at once (as before).
        ...[...cidByToken].map(async ([token, entry]) => {
          try {
            const resp = await window.api.invoke('net:attachmentBase64', ctx.accountId, ctx.folder, ctx.uid, entry.attachment.part) as
              | { ok: true; contentBase64: string; contentType?: string }
              | { ok: false; error?: string }
            if (!resp || !resp.ok) return
            arrived(token, buildInlineImageDataUri(entry.attachment.contentType || resp.contentType, resp.contentBase64))
          } catch { /* a part that does not arrive keeps its placeholder and its chip */ }
        }),
        // External images, in batches of 6 so the main process is not swamped.
        (async () => {
          const BATCH = 6
          const tokens = [...externalByToken]
          for (let i = 0; i < tokens.length && !cancelled; i += BATCH) {
            await Promise.all(tokens.slice(i, i + BATCH).map(async ([token, url]) => {
              try {
                const resp = await window.api.invoke('net:fetchExternalImage', url) as
                  | { ok: true; contentBase64: string; contentType: string }
                  | { ok: false; error?: string }
                // On !ok / throw the placeholder simply stays — the raw URL never reaches the DOM.
                if (resp?.ok) arrived(token, buildInlineImageDataUri(resp.contentType, resp.contentBase64))
              } catch { /* network / IPC failure — placeholder stays */ }
            }))
          }
        })(),
      ])
    })()

    return () => {
      cancelled = true
      if (liveRun.current?.flush === flush) liveRun.current = null
    }
    // `preparedHtml` and `cidPartsToInline` are memoized from details.html /
    // details.attachments, so they are the granular deps — anything else inside
    // `details` (text body, flags, envelope) does not affect the srcdoc.
    // Keeping the dep list tight avoids redundant pipeline reruns on unrelated
    // detail updates. `details?.html` stays in the list because the early
    // return above branches on it (an html body that sanitizes to an empty
    // string still produces a srcdoc).
  }, [active, alwaysLoadImages, cidPartsToInline, darkModeEmails, details?.html, iframeRef, preparedHtml, quotedTextLabel, showExternalImages, theme])

  return { doc, hasExternalImages, hiddenAttachments, onIframeLoad }
}
