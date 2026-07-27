/**
 * §3.10 P0 regression suite — HTML email external resource hardening.
 *
 * Asserts three invariants of the renderer iframe for mail HTML rendering:
 *   1. CSP `img-src` is ALWAYS `'self' data: cid:` regardless of the user's
 *      "show external images" preference — http:/https: must never appear in
 *      the directive.
 *   2. The iframe never makes a direct network request to external image
 *      URLs. All fetching is mediated by the main-process SSRF-safe proxy
 *      (`net:fetchExternalImage`) and responses are inlined as `data:` URIs
 *      before being injected into the srcdoc.
 *   3. Failed / blocked external image fetches do not leave raw http(s) URLs
 *      in the iframe DOM — they are replaced with an inert placeholder data
 *      URI. SSRF-class targets (127.0.0.1/RFC1918) are rejected by the main
 *      process and must also end up as placeholders, not as raw URLs.
 */
import { test, expect } from '@playwright/test'
import type { Request as PWRequest } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT, type AppContext } from './helpers'

test('§3.10 P0: renderer never makes direct HTTP requests for external email images', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-ext-img-'))
    const page = ctx.page!

    // --- Observe every renderer-initiated network request ---------------------
    //
    // The critical invariant is that when we open an HTML email with an
    // external <img src="http(s)://...">, the renderer iframe MUST NOT fetch
    // that URL directly. All external-image network activity is routed
    // through the main-process proxy (Node http), which Playwright's
    // page.on('request') does not observe.
    //
    // If any request reaches us here with an external-image host, that is
    // a regression — the iframe was allowed to speak to the network.

    const rendererRequests: { url: string; resourceType: string }[] = []
    const onRequest = (req: PWRequest) => {
      const u = req.url()
      // Ignore non-network schemes and internal navigations.
      if (!/^https?:/i.test(u)) return
      rendererRequests.push({ url: u, resourceType: req.resourceType() })
    }
    page.on('request', onRequest)

    // Open the E2E HTML email. Its fixture contains an external <img> at
    // https://tracker.example.test/pixel.png (see electron/main.ts E2E_TEXTS).
    // Match the HTML email by subject prefix common to all locales.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: /html/i }).first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    const iframe = page.locator('iframe.mail-iframe')
    await expect(iframe).toBeVisible()
    await expect.poll(async () => await iframe.getAttribute('srcdoc'), { timeout: EXPECT_TIMEOUT }).not.toBeNull()

    // --- Assertion 1: CSP stays hardened in the blocked state -----------------
    const srcdocBlocked = (await iframe.getAttribute('srcdoc')) || ''
    expect(srcdocBlocked).toContain("img-src 'self' data: cid:")
    expect(srcdocBlocked).not.toMatch(/img-src[^;"]*\bhttps?:/)

    // --- Assertion 2: "Show images" does NOT relax CSP -----------------------
    //
    // This is the core of this P0. Previously, clicking "Show images" flipped
    // CSP to `img-src https: http: data: cid:`, letting the iframe fetch any
    // URL directly — a tracking/SSRF vector. New invariant: CSP is frozen at
    // `'self' data: cid:` regardless of the setting. External images arrive
    // as inlined data: URIs only.
    const banner = page.getByTestId('images-blocked-banner')
    if (await banner.count() > 0) {
      await banner.locator('button').click()
      // Wait for the "allowed" render cycle to complete. We cannot rely on the
      // srcdoc string changing — when the fixture host (tracker.example.test)
      // is unresolvable, fetchExternalImage fails fast and every extracted URL
      // collapses to the same BLOCKED_IMAGE_PLACEHOLDER_DATA_URI as the
      // pre-click "blocked" pass. Byte-identical srcdoc across the two states
      // is in fact the P0 hardening working as intended (hardened CSP +
      // placeholder-swap in both branches). Use the banner's disappearance as
      // the React-level signal that `showExternalImages` has propagated and
      // the iframe has been re-keyed from `:safe` to `:ext`.
      await expect(banner).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

      const srcdocAllowed = (await iframe.getAttribute('srcdoc')) || ''
      expect(srcdocAllowed).toContain("img-src 'self' data: cid:")
      expect(srcdocAllowed).not.toMatch(/img-src[^;"]*\bhttps?:/)

      // The raw external URL from the fixture must NOT appear in the
      // rendered iframe doc (either inlined or replaced with placeholder).
      expect(srcdocAllowed).not.toContain('https://tracker.example.test/pixel.png')
    }

    // Give the iframe a beat to make any direct HTTP requests it might try.
    await page.waitForTimeout(500)

    // --- Assertion 3: no renderer-originated HTTP to external-image hosts ----
    //
    // page.on('request') observes the entire browser context. Any request
    // here means either the renderer escaped the CSP (bug) or our own app
    // legitimately talked to the network. Filter out expected background
    // traffic (OAuth, updater, Sentry, telemetry hosts) and assert zero
    // requests to email-content hosts.
    const rendererFacingEmailRequests = rendererRequests.filter(({ url }) => {
      // Anything pointing at the fixture tracker or SSRF targets is a failure.
      if (url.includes('tracker.example.test')) return true
      if (/https?:\/\/127\.0\.0\.1/.test(url)) return true
      if (/https?:\/\/10\./.test(url)) return true
      if (/https?:\/\/192\.168\./.test(url)) return true
      if (/https?:\/\/169\.254\./.test(url)) return true
      return false
    })

    expect(
      rendererFacingEmailRequests,
      `Renderer fired network requests for email-content URLs (should have been blocked by CSP / proxied via main): ${JSON.stringify(rendererFacingEmailRequests, null, 2)}`,
    ).toEqual([])

    page.off('request', onRequest)
  } finally {
    await cleanupApp(ctx)
  }
})
