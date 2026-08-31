// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useMailIframeDoc } from './useMailIframeDoc'
import type { AttachmentMeta, MailSummary, MessageDetails } from '../../packages/net/types'

// Mock window.api for IPC calls. Individual tests override mockInvoke
// behavior — by default it returns `!ok`, which sends the pipeline down
// the placeholder path (still a valid srcdoc).
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
  writable: true,
})

function makeActive(uid = 1): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid,
    subject: 's',
    from: 'a@test',
    fromAddr: 'a@test',
    date: '2026-01-01T00:00:00Z',
    unread: false,
    flagged: false,
    hasAttachments: false,
  }
}

function makeDetails(html: string | undefined, overrides: Partial<MessageDetails> = {}): MessageDetails {
  return {
    uid: 1,
    html,
    text: '',
    attachments: [],
    ...overrides,
  }
}

// Baseline hook params. IMPORTANT — the params object passed to
// useMailIframeDoc must be STABLE across rerenders (effect deps compare by
// identity for object fields). In renderHook tests we achieve this by
// constructing the props object ONCE outside the render callback and then
// passing it as `initialProps`, or by threading stable references through
// a closure. Creating a fresh `defaultParams()` inside the render callback
// would trigger an infinite effect loop.
function makeParams(overrides: Partial<{
  active: MailSummary | null
  details: MessageDetails | null
  alwaysLoadImages: boolean
  showExternalImages: boolean
  darkModeEmails: boolean
  theme: 'light' | 'dark'
  quotedTextLabel: string
}> = {}) {
  return {
    active: makeActive(),
    details: makeDetails('<p>hello</p>'),
    alwaysLoadImages: false,
    showExternalImages: false,
    darkModeEmails: false,
    theme: 'light' as const,
    quotedTextLabel: 'Show quoted text',
    ...overrides,
  }
}

describe('useMailIframeDoc', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    // Default — any IPC returns !ok so nothing inlines; pipeline goes down
    // the placeholder path, which still produces a valid srcdoc.
    mockInvoke.mockResolvedValue({ ok: false })
  })
  afterEach(() => {
    // Explicit React Testing Library cleanup — otherwise the previous test's
    // hook instance stays mounted across tests and its in-flight effect
    // keeps scheduling state updates into the next test's assertions.
    cleanup()
    vi.restoreAllMocks()
  })

  it('returns null doc when no active message', () => {
    const params = makeParams({ active: null })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })
    expect(result.current.doc).toBeNull()
    expect(result.current.hasExternalImages).toBe(false)
  })

  it('returns null doc when details has no html body', () => {
    const params = makeParams({ details: makeDetails(undefined) })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })
    expect(result.current.doc).toBeNull()
    expect(result.current.hasExternalImages).toBe(false)
  })

  it('returns a non-null srcdoc for html without external images', async () => {
    const params = makeParams({
      details: makeDetails('<p>hello <b>world</b></p>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })

    // No external fetch attempted — empty URL list short-circuits fetchExternal.
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.current.doc).toContain('<p>hello <b>world</b></p>')
    expect(result.current.doc).toContain("img-src 'self' data: cid:")
    expect(result.current.hasExternalImages).toBe(false)
  })

  it('when allowExternal=true and fetch succeeds, replaces URL with inlined data URI', async () => {
    mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'net:fetchExternalImage') {
        const url = args[0] as string
        if (url === 'https://a.test/img.png') {
          return { ok: true, contentBase64: 'AAAA', contentType: 'image/png' }
        }
      }
      return { ok: false }
    })

    const params = makeParams({
      alwaysLoadImages: true,
      details: makeDetails('<img src="https://a.test/img.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
      expect(result.current.doc).toContain('data:image/png;base64,AAAA')
    })
    expect(result.current.doc).not.toContain('https://a.test/img.png')
    expect(result.current.hasExternalImages).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('net:fetchExternalImage', 'https://a.test/img.png')
  })

  it('when allowExternal=false, every external URL is replaced with placeholder (no fetch fires)', async () => {
    const params = makeParams({
      details: makeDetails('<img src="https://tracker.test/pixel.gif">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })

    // No fetch attempted — fetchExternal short-circuits on !allowExternal.
    expect(mockInvoke).not.toHaveBeenCalled()
    // Raw URL replaced with placeholder data: URI.
    expect(result.current.doc).not.toContain('https://tracker.test/pixel.gif')
    expect(result.current.doc).toMatch(/data:image\/svg\+xml/)
    // Banner flag is TRUE — there were external images, the pipeline just blocked them.
    expect(result.current.hasExternalImages).toBe(true)
  })

  it('switching active message cancels stale fetch (no setState on previous email)', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined
    const firstPromise = new Promise<unknown>((resolve) => { resolveFirst = resolve })
    mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'net:fetchExternalImage') {
        const url = args[0] as string
        if (url === 'https://a.test/stale.png') return await firstPromise
        if (url === 'https://b.test/fresh.png') {
          return { ok: true, contentBase64: 'FRESH', contentType: 'image/png' }
        }
      }
      return { ok: false }
    })

    const initial = makeParams({
      alwaysLoadImages: true,
      active: makeActive(1),
      details: makeDetails('<img src="https://a.test/stale.png">'),
    })
    const { result, rerender } = renderHook(
      (p: typeof initial) => useMailIframeDoc(p),
      { initialProps: initial },
    )

    // Let the first pipeline start (it will hang on firstPromise).
    await Promise.resolve()

    // Switch to a different active message while the first fetch is still pending.
    const next = makeParams({
      alwaysLoadImages: true,
      active: makeActive(2),
      details: makeDetails('<img src="https://b.test/fresh.png">'),
    })
    rerender(next)

    // Wait for the fresh srcdoc to land.
    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
      expect(result.current.doc).toContain('data:image/png;base64,FRESH')
    })

    // Now unblock the stale fetch. Its completion path must check `cancelled`
    // and NOT clobber the fresh srcdoc.
    if (resolveFirst) resolveFirst({ ok: true, contentBase64: 'STALE', contentType: 'image/png' })

    // Give microtasks time for the stale resolution to flow through.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(result.current.doc).not.toContain('STALE')
    expect(result.current.doc).toContain('FRESH')
  })

  it('applies dark-mode filter CSS only when theme=dark AND darkModeEmails=true', async () => {
    const light = makeParams({ details: makeDetails('<p>x</p>'), theme: 'light', darkModeEmails: true })
    const { result, rerender } = renderHook(
      (p: typeof light) => useMailIframeDoc(p),
      { initialProps: light },
    )

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    // Light theme → no invert filter even if darkModeEmails preference is on.
    expect(result.current.doc).not.toContain('filter:invert(1)')

    const dark = makeParams({ details: makeDetails('<p>x</p>'), theme: 'dark', darkModeEmails: true })
    rerender(dark)
    await waitFor(() => {
      expect(result.current.doc).toContain('filter:invert(1)')
    })

    const darkOff = makeParams({ details: makeDetails('<p>x</p>'), theme: 'dark', darkModeEmails: false })
    rerender(darkOff)
    await waitFor(() => {
      const d = result.current.doc
      expect(d !== null && d.includes('filter:invert(1)')).toBe(false)
    })
  })

  it('CSP in produced srcdoc is always `img-src self data cid:` — never http(s)', async () => {
    const params = makeParams({
      alwaysLoadImages: true, // Even with external-allowed, CSP stays hard-pinned.
      details: makeDetails('<img src="https://x.test/a.png"><div style="background:url(https://x.test/b.png)">z</div>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })
    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    expect(doc).toContain("img-src 'self' data: cid:")
    expect(doc).not.toMatch(/img-src[^;"]*\bhttps?:/)
  })

  it('srcdoc never contains raw http(s) URL in image-bearing position even under adversarial input', async () => {
    // Adversarial payload mixing bypass classes (matches wave-3 regression).
    const adversarial = [
      '<img src="//tracker.test/1.png">',
      '<img src=https://tracker.test/2.png>',
      '<img src="https&#58;//tracker.test/3.png">',
      '<svg><image href="https://tracker.test/4.png"/></svg>',
      '<td background="https://tracker.test/5.png">x</td>',
      '<video poster="https://tracker.test/6.jpg"></video>',
      '<audio src="https://tracker.test/7.mp3"></audio>',
      '<div style="background:url(https://tracker.test/8.png)">z</div>',
    ].join('')

    const params = makeParams({ details: makeDetails(adversarial) })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })
    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    for (let i = 1; i <= 8; i++) {
      expect(doc).not.toContain(`https://tracker.test/${i}.png`)
      expect(doc).not.toContain(`https://tracker.test/${i}.jpg`)
      expect(doc).not.toContain(`https://tracker.test/${i}.mp3`)
    }
    expect(doc).not.toContain('//tracker.test/')
  })

  it('fetch throw (network error / SSRF block) lands placeholder in srcdoc, not raw URL', async () => {
    // Brief item (d): allowExternal=true path where the main-process proxy
    // throws (SSRF rejection, ERR_NETWORK_CHANGED, IPC failure) must fall
    // through to the placeholder branch. The invariant "no raw http(s) URL
    // in iframe DOM" holds even when the fetch pipeline errors out, not just
    // when it returns { ok: false }.
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'net:fetchExternalImage') {
        throw new Error('SSRF: target rejected (127.0.0.1)')
      }
      return { ok: false }
    })

    const params = makeParams({
      alwaysLoadImages: true,
      details: makeDetails('<img src="https://127.0.0.1/pixel.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Raw URL must not survive — placeholder takes its place.
    expect(doc).not.toContain('https://127.0.0.1/pixel.png')
    expect(doc).toMatch(/data:image\/svg\+xml/)
    // Banner still reflects that external images were present.
    expect(result.current.hasExternalImages).toBe(true)
    // Fetch was attempted (we want to prove the throw path, not short-circuit).
    expect(mockInvoke).toHaveBeenCalledWith('net:fetchExternalImage', 'https://127.0.0.1/pixel.png')
  })

  it('hasExternalImages is false when sanitizer strips the only external-bearing tags (pipeline-stripped)', async () => {
    // Brief item (h): derivation must be authoritative — if the sanitizer
    // removes the tag before the extractor observes it, there is nothing to
    // rewrite and the banner must stay hidden. This is the property that
    // differentiates the new extractor-derived flag from the wave-1 regex
    // heuristic (which would have matched the raw URL substring and shown
    // the banner for content the pipeline has already neutralized).
    const params = makeParams({
      details: makeDetails(
        // <video>, <audio>, <feImage> are all dropped by FORBID_TAGS. No
        // surviving resource-bearing element → no external URL in DOM.
        '<video src="https://tracker.test/v.mp4"></video>'
        + '<audio src="https://tracker.test/a.mp3"></audio>'
        + '<svg><filter><feImage href="https://tracker.test/p.png"/></filter></svg>',
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    // Banner MUST stay hidden — everything was pipeline-stripped.
    expect(result.current.hasExternalImages).toBe(false)
    // And no raw URL leaked into the rendered srcdoc.
    const doc = result.current.doc!
    expect(doc).not.toContain('https://tracker.test/')
  })

  // --- §3.10 polish wave: lazy-load banner regression (codex NEEDS_FIX MEDIUM) --
  //
  // Before the fix, `data-src` / `data-original` / `data-srcset` were
  // promoted to real `src` / `srcset` attributes ONLY when
  // allowExternal=true. In the pre-click blocked state DOMPurify stripped
  // the `data-*` attributes (ALLOW_DATA_ATTR: false), the extractor
  // observed zero URLs, hasExternalImages stayed false, and the "Show
  // images" banner never appeared — chicken-and-egg. Fix: promote
  // unconditionally, with DOM-aware avoidance of duplicate `src=`.

  it('lazy-load data-src is extracted as external image when allowExternal=false (banner visible)', async () => {
    const params = makeParams({
      alwaysLoadImages: false,
      showExternalImages: false,
      details: makeDetails('<img data-src="https://lazy.test/p.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    // Banner MUST appear — the user needs a way to opt in.
    expect(result.current.hasExternalImages).toBe(true)
  })

  it('lazy-load data-src in blocked state is replaced with placeholder (no raw URL in srcdoc)', async () => {
    const params = makeParams({
      alwaysLoadImages: false,
      showExternalImages: false,
      details: makeDetails('<img data-src="https://lazy.test/p.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Raw URL never reaches the iframe DOM.
    expect(doc).not.toContain('https://lazy.test/p.png')
    // Placeholder data: URI takes its place.
    expect(doc).toMatch(/data:image\/svg\+xml/)
    // No fetch fired — allowExternal=false short-circuits the proxy path.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('lazy-load with placeholder src + data-src: data-src wins, no duplicate src= attributes', async () => {
    // <img src="placeholder.gif" data-src="real.jpg"> must not end up with
    // TWO `src=` attributes in the rewritten HTML — HTML parsers pick one
    // non-deterministically. Wave-2 rule (HIGH/MEDIUM polish): data-src wins
    // — it is the real URL by lazy-load convention, src is the placeholder.
    // Previous "src absent" rule silently lost the real URL whenever a
    // placeholder was present, making the image unreachable and leaving the
    // user with no opt-in path. Both URLs still flow through the pipeline
    // (the placeholder is discarded before extraction, only the promoted
    // data-src value is observed); with mockInvoke default `{ok: false}` the
    // real URL is mapped to placeholder too.
    const params = makeParams({
      alwaysLoadImages: true,
      showExternalImages: true,
      details: makeDetails(
        '<img src="https://placeholder.test/gif.gif" data-src="https://lazy.test/real.jpg">',
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Neither raw URL survives in any image-bearing position — both are
    // mapped to placeholder (mockInvoke default returns {ok:false}).
    expect(doc).not.toContain('https://placeholder.test/gif.gif')
    expect(doc).not.toContain('https://lazy.test/real.jpg')
    // data-src / data-original attributes are gone from the rendered DOM
    // (DOMPurify ALLOW_DATA_ATTR:false and our promotion step both
    // contribute to this, defence-in-depth).
    expect(doc).not.toContain('data-src=')
    expect(doc).not.toContain('data-original=')
    // Check no duplicate src= attribute on a single <img> tag. Look for the
    // <img …> tag and verify it has at most one `src=`.
    const imgMatches = doc.match(/<img\b[^>]*>/gi) || []
    for (const tag of imgMatches) {
      const srcCount = (tag.match(/\bsrc\s*=/gi) || []).length
      expect(srcCount).toBeLessThanOrEqual(1)
    }
  })

  // --- §3.10 polish wave-2: HIGH — smuggling via data-src on non-image tags -
  //
  // The wave-1 promotion was tag-agnostic. `<a data-src="https://smuggle">
  // link</a>` became `<a src="https://smuggle">link</a>` after promotion.
  // DOMPurify's default ALLOWED_ATTR accepts `src` globally (no per-tag
  // restriction), so DOMPurify did NOT strip it from <a>. The external-image
  // extractor scans `<img>/<source>/<input type=image>` only — misses <a>.
  // Result: raw URL lives in iframe DOM, `hasExternalImages=false`, no
  // banner, no rewrite. New smuggling path. Fix: restrict promotion to
  // `<img>, <source>` only.
  it('non-image element (anchor) with data-src: attribute is NOT promoted to src', async () => {
    const params = makeParams({
      alwaysLoadImages: true,
      showExternalImages: true,
      details: makeDetails('<a data-src="https://smuggle.test/p.png">click</a>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Raw URL MUST NOT appear anywhere in the rendered DOM — promotion is
    // scoped to `<img>/<source>`, and DOMPurify strips data-* on everything.
    expect(doc).not.toContain('https://smuggle.test/p.png')
    // No `src` attribute on <a> (confirms promotion didn't run for non-image).
    const anchorMatches = doc.match(/<a\b[^>]*>/gi) || []
    for (const tag of anchorMatches) {
      expect(tag).not.toMatch(/\bsrc\s*=/)
    }
    // And the extractor did not register this as an external image (nothing
    // image-bearing present), so the banner stays hidden.
    expect(result.current.hasExternalImages).toBe(false)
  })

  it('non-image element (div) with data-src: attribute is NOT promoted', async () => {
    const params = makeParams({
      alwaysLoadImages: true,
      showExternalImages: true,
      details: makeDetails('<div data-src="https://smuggle.test/p.png">text</div>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    expect(doc).not.toContain('https://smuggle.test/p.png')
    const divMatches = doc.match(/<div\b[^>]*>/gi) || []
    for (const tag of divMatches) {
      expect(tag).not.toMatch(/\bsrc\s*=/)
    }
    expect(result.current.hasExternalImages).toBe(false)
  })

  it('non-image element (text input) with data-src: attribute is NOT promoted', async () => {
    // `<input type="text" data-src=...>` is not a lazy-load target — real
    // lazy-load libs only touch <img>/<source>. We include <input> in the
    // smuggling vector class because it is yet another non-<img> element
    // where a promoted `src=` would survive DOMPurify.
    const params = makeParams({
      alwaysLoadImages: true,
      showExternalImages: true,
      details: makeDetails('<input type="text" data-src="https://smuggle.test/p.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    expect(doc).not.toContain('https://smuggle.test/p.png')
    const inputMatches = doc.match(/<input\b[^>]*>/gi) || []
    for (const tag of inputMatches) {
      expect(tag).not.toMatch(/\bsrc\s*=/)
    }
    expect(result.current.hasExternalImages).toBe(false)
  })

  // --- §3.10 polish wave-2: MEDIUM — placeholder data: URI blocks real ------
  //
  // The common lazy-load pattern is `<img src="data:...1x1placeholder..."
  // data-src="https://real.cdn/photo.jpg">`. Wave-1 "src absent" rule left
  // the placeholder in place; DOMPurify then stripped `data-src`, and the
  // real URL was lost forever. Extractor saw only the `data:` placeholder
  // (not http(s)), `hasExternalImages=false`, banner never appeared. Fix:
  // data-src overwrites src unconditionally on `<img>/<source>`.
  it('data: URI placeholder src + http(s) data-src: data-src wins, real URL flows through pipeline', async () => {
    mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'net:fetchExternalImage') {
        const url = args[0] as string
        if (url === 'https://real.test/photo.jpg') {
          return { ok: true, contentBase64: 'REAL', contentType: 'image/jpeg' }
        }
      }
      return { ok: false }
    })

    const params = makeParams({
      alwaysLoadImages: true,
      details: makeDetails(
        '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://real.test/photo.jpg">',
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Real URL observed by the pipeline and inlined as data URI.
    expect(doc).toContain('data:image/jpeg;base64,REAL')
    // Raw http(s) URL must NOT survive.
    expect(doc).not.toContain('https://real.test/photo.jpg')
    // Banner true — the real URL was observed.
    expect(result.current.hasExternalImages).toBe(true)
    // Fetch fired for the real URL, not the data: placeholder.
    expect(mockInvoke).toHaveBeenCalledWith('net:fetchExternalImage', 'https://real.test/photo.jpg')
  })

  it('http(s) placeholder src + http(s) data-src: data-src wins (placeholder never observed)', async () => {
    // Wave-2 change: both URLs are no longer processed — only the promoted
    // data-src value survives into the extractor. With mockInvoke default
    // `{ok: false}` it maps to placeholder, but the extractor never sees
    // the placeholder URL at all.
    mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'net:fetchExternalImage') {
        const url = args[0] as string
        if (url === 'https://real.test/photo.jpg') {
          return { ok: true, contentBase64: 'REAL', contentType: 'image/jpeg' }
        }
        // Placeholder URL should never be fetched because data-src overwrote it.
        return { ok: false }
      }
      return { ok: false }
    })

    const params = makeParams({
      alwaysLoadImages: true,
      details: makeDetails(
        '<img src="https://placeholder.test/1x1.gif" data-src="https://real.test/photo.jpg">',
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    expect(doc).toContain('data:image/jpeg;base64,REAL')
    expect(doc).not.toContain('https://real.test/photo.jpg')
    expect(doc).not.toContain('https://placeholder.test/1x1.gif')
    expect(result.current.hasExternalImages).toBe(true)
    // Fetch fired only for the data-src target, not the placeholder — the
    // promotion overwrites src before extraction.
    expect(mockInvoke).toHaveBeenCalledWith('net:fetchExternalImage', 'https://real.test/photo.jpg')
    expect(mockInvoke).not.toHaveBeenCalledWith('net:fetchExternalImage', 'https://placeholder.test/1x1.gif')
  })

  it('cid: placeholder src + http(s) data-src: promotion runs BEFORE cid inlining, data-src wins', async () => {
    // Pipeline order (see useMailIframeDoc.ts): promoteLazyLoadAttrs →
    // sanitize → cid inlining → external extract. The cid:img1 placeholder
    // is overwritten by the data-src before cid inlining fires, so this
    // boils down to the same "data-src wins" path as the data: placeholder
    // test above. No cid attachment is ever observed by the cid logic.
    mockInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'net:fetchExternalImage') {
        const url = args[0] as string
        if (url === 'https://real.test/photo.jpg') {
          return { ok: true, contentBase64: 'REAL', contentType: 'image/jpeg' }
        }
      }
      return { ok: false }
    })

    const params = makeParams({
      alwaysLoadImages: true,
      details: makeDetails(
        '<img src="cid:img1" data-src="https://real.test/photo.jpg">',
        // Provide an inline attachment for cid:img1 to confirm cid inlining
        // does NOT run (the cid: src is overwritten before it is observed).
        {
          attachments: [
            { filename: 'img1.png', contentType: 'image/png', size: 10, disposition: 'inline', cid: 'img1', part: '1.1' },
          ],
        },
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Real URL won the promotion and flowed through the external-image pipeline.
    expect(doc).toContain('data:image/jpeg;base64,REAL')
    expect(doc).not.toContain('https://real.test/photo.jpg')
    // cid reference was overwritten before cid inlining — no cid: token in DOM.
    expect(doc).not.toContain('cid:img1')
    expect(result.current.hasExternalImages).toBe(true)
    // Fetch fired for the real URL. `net:attachmentBase64` (cid path) was
    // NOT invoked because cid:img1 was removed before the cid scan.
    expect(mockInvoke).toHaveBeenCalledWith('net:fetchExternalImage', 'https://real.test/photo.jpg')
    expect(mockInvoke).not.toHaveBeenCalledWith('net:attachmentBase64', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('lazy-load data-srcset is promoted and both URLs flow through the pipeline', async () => {
    const params = makeParams({
      alwaysLoadImages: false,
      showExternalImages: false,
      details: makeDetails(
        '<img data-srcset="https://lazy.test/1x.png 1x, https://lazy.test/2x.png 2x">',
      ),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // Banner must show — user can opt in to load both.
    expect(result.current.hasExternalImages).toBe(true)
    // Neither srcset URL leaks — both replaced with placeholder.
    expect(doc).not.toContain('https://lazy.test/1x.png')
    expect(doc).not.toContain('https://lazy.test/2x.png')
    expect(doc).not.toContain('data-srcset=')
  })

  it('lazy-load data-original is promoted (legacy jQuery Lazy Load attribute)', async () => {
    const params = makeParams({
      alwaysLoadImages: false,
      showExternalImages: false,
      details: makeDetails('<img data-original="https://legacy.test/p.png">'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    expect(result.current.hasExternalImages).toBe(true)
    const doc = result.current.doc!
    expect(doc).not.toContain('https://legacy.test/p.png')
  })

  // --- §3.3.C-thread.2: quoted-text collapse ----------------------------------

  it('quoted-text collapse: blockquote in html body is wrapped in <details>', async () => {
    const params = makeParams({
      quotedTextLabel: 'Show quoted text',
      details: makeDetails('<p>My reply</p><blockquote><p>Original message</p></blockquote>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    expect(doc).toContain('<details>')
    expect(doc).toContain('<summary>Show quoted text</summary>')
    expect(doc).toContain('My reply')
    expect(doc).toContain('Original message')
    // Default collapsed: no `open` attribute on <details>.
    expect(doc).not.toMatch(/<details[^>]+open/)
  })

  it('quoted-text collapse: html without blockquote passes through unchanged (no <details>)', async () => {
    const params = makeParams({
      details: makeDetails('<p>Hello <b>world</b></p>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    expect(result.current.doc).not.toContain('<details>')
    expect(result.current.doc).toContain('Hello')
  })

  it('quoted-text collapse: quotedTextLabel is reflected in summary element', async () => {
    const params = makeParams({
      quotedTextLabel: 'Показать цитируемый текст',
      details: makeDetails('<p>A</p><blockquote><p>Q</p></blockquote>'),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    expect(result.current.doc).toContain('<summary>Показать цитируемый текст</summary>')
  })

  it('changing quotedTextLabel re-runs pipeline and updates summary text', async () => {
    // quotedTextLabel is in the effect dep array — changing it must trigger
    // a new srcdoc with the updated label, not cache the old one.
    const initial = makeParams({
      quotedTextLabel: 'Show quoted text',
      details: makeDetails('<p>Reply</p><blockquote><p>Q</p></blockquote>'),
    })
    const { result, rerender } = renderHook(
      (p: typeof initial) => useMailIframeDoc(p),
      { initialProps: initial },
    )

    await waitFor(() => {
      expect(result.current.doc).toContain('<summary>Show quoted text</summary>')
    })

    const updated = makeParams({
      quotedTextLabel: 'Afficher le texte cité',
      details: makeDetails('<p>Reply</p><blockquote><p>Q</p></blockquote>'),
    })
    rerender(updated)

    await waitFor(() => {
      expect(result.current.doc).toContain('<summary>Afficher le texte cité</summary>')
    })
    expect(result.current.doc).not.toContain('<summary>Show quoted text</summary>')
  })

  it('quoted-text collapse runs AFTER link rewrite: links inside blockquote are preserved', async () => {
    // collapseQuotedText is called AFTER rewriteMailHtmlLinks (pipeline step 7
    // then step 8). This test verifies the ordering: the <blockquote> wrapping
    // must survive the link-rewrite step and still be picked up by collapse.
    const params = makeParams({
      details: makeDetails('<blockquote><a href="https://example.test">link</a></blockquote>'),
      alwaysLoadImages: false,
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    const doc = result.current.doc!
    // blockquote was collapsed into <details>
    expect(doc).toContain('<details>')
    // link text preserved inside the collapsed block
    expect(doc).toContain('link')
  })

  // -------------------------------------------------------------------------
  // §2.128 — two questions with two different rules.
  //
  //  * what the body INLINES: broad, so images keep rendering wherever the
  //    sender wrote the reference;
  //  * what LOSES ITS CHIP: only a part that is explicitly `inline`, written in
  //    an `<img src>` / `<input type=image src>` position, and whose bytes this
  //    hook actually substituted.
  //
  // Every "keeps its chip" case below was a way to make a real file vanish.
  // -------------------------------------------------------------------------

  /** The parts the hook reports as hidden, by MIME part path. */
  function hiddenParts(result: { current: { hiddenAttachments: { part: string }[] } }): string[] {
    return result.current.hiddenAttachments.map(a => a.part)
  }

  function inlineAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
    return {
      part: '1.1',
      filename: 'logo.png',
      contentType: 'image/png',
      size: 10,
      cid: 'logo@x',
      disposition: 'inline',
      ...overrides,
    } as AttachmentMeta
  }

  function mockCidFetch(base64 = 'LOGO') {
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'net:attachmentBase64'
        ? { ok: true, contentBase64: base64, contentType: 'image/png' }
        : { ok: false },
    )
  }

  it('hides a part that meets all four conditions', async () => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails('<p>hi</p><img src="cid:logo@x">', {
        attachments: [inlineAttachment({ disposition: 'inline; filename="logo.png"' })],
      }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual(['1.1'])
    expect(result.current.doc).toContain('data:image/png;base64,LOGO')
    expect(result.current.doc).not.toContain('cid:logo@x')
  })

  // A `Content-ID` is text the sender chooses, so it must be treated as data
  // and never as a property name. In an object literal `__proto__` is an
  // inherited setter: the write created no own property, the substitution
  // never happened — and the part was nevertheless counted as substituted, so
  // its chip disappeared and the file was reachable from nowhere. `constructor`
  // is the control: it always did become an own key, and must keep working.
  it.each(['__proto__', 'constructor', 'toString'])(
    'substitutes and hides a part whose Content-ID is %s',
    async (cid) => {
      mockCidFetch()
      const params = makeParams({
        details: makeDetails(`<p>hi</p><img src="cid:${cid}">`, {
          attachments: [inlineAttachment({ cid })],
        }),
      })
      const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

      await waitFor(() => { expect(result.current.doc).not.toBeNull() })
      // The image is drawn...
      expect(result.current.doc).toContain('data:image/png;base64,LOGO')
      expect(result.current.doc).not.toContain(`cid:${cid}`)
      // ...which is the only thing that permits dropping the chip.
      expect(hiddenParts(result)).toEqual(['1.1'])
    },
  )

  // Condition 4. The bytes never arrived, so the body shows a broken image —
  // the chip is then the only way left to reach the file.
  it('keeps the chip when the byte fetch fails', async () => {
    mockInvoke.mockResolvedValue({ ok: false })
    const params = makeParams({
      details: makeDetails('<img src="cid:logo@x">', { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
    expect(result.current.doc).toContain('cid:logo@x')
  })

  it('keeps the chip when the fetch throws', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'net:attachmentBase64') throw new Error('IPC gone')
      return { ok: false }
    })
    const params = makeParams({
      details: makeDetails('<img src="cid:logo@x">', { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
  })

  // Condition 2 — a part the sender never labelled `inline` may be a file.
  it('keeps the chip of a part with no disposition, and still draws it', async () => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails('<img src="cid:logo@x">', {
        attachments: [inlineAttachment({ disposition: undefined })],
      }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
    expect(result.current.doc).toContain('data:image/png;base64,LOGO')
  })

  // Condition 3 — the iteration-4 narrowing. These positions all survive
  // sanitization and still get their bytes (rendering is untouched), but none
  // of them proves the browser drew the part, so the chip stays.
  it.each([
    ['a style attribute', '<div style="background:url(cid:logo@x)"></div>'],
    ['a source element', '<picture><source media="not all" srcset="cid:logo@x"><img src="other.png"></picture>'],
    ['a srcset candidate', '<img srcset="cid:logo@x 2x" src="other.png">'],
  ])('inlines but does not hide a part referenced only from %s', async (_label, html) => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails(html, { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    // Rendering is untouched by the narrowing: the bytes are still inlined.
    expect(result.current.doc).toContain('data:image/png;base64,LOGO')
    expect(hiddenParts(result)).toEqual([])
  })

  // The same for stylesheet positions. No assertion on the bytes here: jsdom's
  // DOMPurify drops <style> outright, so the reference does not survive
  // sanitization in this environment at all. That `selectCidPartsToInline`
  // still resolves such references (i.e. the browser build keeps drawing them)
  // is pinned in `packages/core/cidRefs.test.ts`.
  it.each([
    ['a CSS background', '<style>.hero{background:url(cid:logo@x)}</style><div class="hero"></div>'],
    ['a media query that never applies', '<style>@media not all{.h{background:url(cid:logo@x)}}</style>'],
    ['an unused custom property', '<style>:root{--unused:url(cid:logo@x)}</style>'],
    ['a CDATA section', '<style><![CDATA[url(cid:logo@x)]]></style>'],
    ['an escaped @import prelude', '<style>@\\69 mport url(cid:logo@x);</style>'],
  ])('does not hide a part referenced only from %s', async (_label, html) => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails(html, { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
  })

  it('hides only the src of a srcset image, never its candidates', async () => {
    mockCidFetch()
    const attachments = [
      inlineAttachment({ part: '1.1', cid: 'a@x' }),
      inlineAttachment({ part: '1.2', cid: 'b@x' }),
      inlineAttachment({ part: '1.3', cid: 'c@x' }),
    ]
    const params = makeParams({
      details: makeDetails('<img srcset="cid:a@x 1x, cid:b@x 2x" src="cid:c@x">', { attachments }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    // All three are inlined — the browser may pick any candidate.
    expect(mockInvoke).toHaveBeenCalledTimes(3)
    expect(hiddenParts(result)).toEqual(['1.3'])
  })

  it('never inlines or hides a part the sender marked as an attachment', async () => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails('<img src="cid:logo@x">', {
        attachments: [inlineAttachment({ disposition: 'attachment; filename="logo.png"' })],
      }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalledWith('net:attachmentBase64', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('keeps the chip of a part whose cid only appears where nothing draws', async () => {
    mockCidFetch()
    const params = makeParams({
      details: makeDetails('<p>see cid:logo@x</p><a href="cid:logo@x">open</a>', {
        attachments: [inlineAttachment()],
      }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
  })

  it('keeps the chip of a part referenced only from a position the sanitizer removes', async () => {
    // DOMPurify drops <video> together with its children, so this <img> is not
    // in the rendered body at all. The decision runs on the SANITIZED html.
    mockCidFetch()
    const params = makeParams({
      details: makeDetails('<video><img src="cid:logo@x"></video>', {
        attachments: [inlineAttachment()],
      }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalledWith('net:attachmentBase64', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('stops at the inlining ceiling, so the overflow keeps its chips', async () => {
    mockCidFetch()
    const attachments = Array.from({ length: 30 }, (_, i) =>
      inlineAttachment({ part: `1.${i}`, cid: `img${i}@x` }),
    )
    const html = attachments.map(a => `<img src="cid:${a.cid}">`).join('')
    const params = makeParams({ details: makeDetails(html, { attachments }) })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    expect(hiddenParts(result)).toHaveLength(25)
    expect(hiddenParts(result)).not.toContain('1.25')
    // ...and the overflow references really are still un-substituted.
    expect(result.current.doc).toContain('cid:img25@x')
    expect(result.current.doc).not.toContain('cid:img24@x')
    expect(mockInvoke).toHaveBeenCalledTimes(25)
  })

  it('reports nothing hidden for a message with no html body', () => {
    const params = makeParams({
      details: makeDetails(undefined, { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })
    expect(result.current.hiddenAttachments).toEqual([])
  })

  it('reports nothing hidden until the substitution has finished', async () => {
    // Direction of the only transition: chips start visible and may disappear
    // once the bytes are in. Never the other way round.
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel !== 'net:attachmentBase64') return { ok: false }
      await gate
      return { ok: true, contentBase64: 'LOGO', contentType: 'image/png' }
    })

    const params = makeParams({
      details: makeDetails('<img src="cid:logo@x">', { attachments: [inlineAttachment()] }),
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    expect(result.current.hiddenAttachments).toEqual([])
    expect(result.current.doc).toBeNull()

    release!()
    await waitFor(() => { expect(result.current.doc).not.toBeNull() })
    // The chip row and the body land in the same commit.
    expect(hiddenParts(result)).toEqual(['1.1'])
  })

  it('does not crash when details.attachments is undefined (optional field)', async () => {
    // MessageDetails.attachments is optional in the type; the hook must not
    // assume an array. With a cid: reference present we also exercise the
    // `hasCids && inlineAtts.length > 0` short-circuit path.
    const params = makeParams({
      details: {
        uid: 1,
        html: '<p>hello <img src="cid:foo"></p>',
        text: '',
        // attachments intentionally omitted.
      } as unknown as import('../../packages/net/types').MessageDetails,
    })
    const { result } = renderHook((p) => useMailIframeDoc(p), { initialProps: params })

    await waitFor(() => {
      expect(result.current.doc).not.toBeNull()
    })
    // cid: reference with no inline attachments — not rewritten, but must
    // not crash. CSP + srcdoc remain intact.
    expect(result.current.doc).toContain("img-src 'self' data: cid:")
    // No external URL → banner hidden.
    expect(result.current.hasExternalImages).toBe(false)
    // No fetch fired (no external URLs, no inline attachments).
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
