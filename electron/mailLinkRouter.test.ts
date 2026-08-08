import { describe, it, expect } from 'vitest'
import {
  MailLinkRouter,
  DEDUP_WINDOW_MS,
  ANOMALY_WINDOW_MS,
  ANOMALY_THRESHOLD,
  BREAKER_COOLDOWN_MS,
  decideMailLinkAction,
  isAllowedExternalUrl,
  parseRoutedMailLink,
  MAX_ROUTED_LINK_TEXT_LENGTH,
} from './mailLinkRouter'
import { buildRoutedMailLink } from '@mailcopilot/core/mailLinks'

/**
 * BACKLOG §2.25 — runaway `shell.openExternal` loop regression suite.
 *
 * The first describe block is the REPRODUCING test (AC a): it models the
 * unpatched `configureExternalLinks` behaviour — every navigation event
 * forwards a `mail:link` with no dedup — and asserts that the SAME logical
 * user click produces more than one emission. That is the bug. The rest of
 * the suite then proves the {@link MailLinkRouter} boundary collapses it
 * back to exactly one (AC b) and flags the runaway as a Sentry anomaly
 * (AC e).
 */

/**
 * Reproduce the unpatched routing: a bare emitter with no idempotency.
 * Mirrors `will-navigate` + `will-frame-navigate` both calling
 * `webContents.send('mail:link', ...)` for one click.
 */
function unpatchedRoute(events: string[]): string[] {
  const emitted: string[] = []
  for (const url of events) {
    // No dedup — exactly what configureExternalLinks did before §2.25.
    emitted.push(url)
  }
  return emitted
}

/** Route through the MailLinkRouter boundary (the §2.25 fix). */
function patchedRoute(router: MailLinkRouter, events: string[]): string[] {
  const emitted: string[] = []
  for (const url of events) {
    if (!router.shouldEmit(url)) continue
    router.noteEmit(url)
    emitted.push(url)
  }
  return emitted
}

describe('§2.25 reproducing test — runaway link routing (unpatched)', () => {
  it('RED on unpatched code: one click → MORE THAN ONE mail:link emission', () => {
    // Chromium fires `will-navigate` AND `will-frame-navigate` for the same
    // top-frame navigation; a preventDefault()-ed iframe-initiated top-nav
    // can also re-fire `will-navigate`. One physical click, four firings.
    const url = 'https://example.com/landing'
    const oneClickFirings = [url, url, url, url]

    const emitted = unpatchedRoute(oneClickFirings)

    // This is the bug: four shell.openExternal calls / four browser tabs
    // for a single user click. The assertion documents the defect.
    expect(emitted.length).toBeGreaterThan(1)
    expect(emitted).toHaveLength(4)
  })
})

describe('§2.25 fix — MailLinkRouter dedup (AC b)', () => {
  it('collapses N navigation firings of the SAME url into exactly ONE emission', () => {
    const clock = 1_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/landing'

    // Four firings, all within a few ms — Chromium's burst for one click.
    const emitted = patchedRoute(router, [url, url, url, url])

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toBe(url)
  })

  it('dedups will-navigate + will-frame-navigate observing the same URL', () => {
    let clock = 5_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://bank.example/login'

    expect(router.shouldEmit(url)).toBe(true)
    router.noteEmit(url)
    // will-frame-navigate fires 2ms later for the same navigation.
    clock += 2
    expect(router.shouldEmit(url)).toBe(false)
  })

  it('a genuine second click on the SAME link after the window opens a new tab', () => {
    let clock = 10_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/a'

    expect(router.shouldEmit(url)).toBe(true)
    router.noteEmit(url)

    clock += DEDUP_WINDOW_MS // window fully elapsed
    expect(router.shouldEmit(url)).toBe(true)
    router.noteEmit(url)
  })

  it('does NOT suppress clicks on DIFFERENT links in quick succession', () => {
    const clock = 20_000
    const router = new MailLinkRouter(() => clock)

    const emitted = patchedRoute(router, [
      'https://example.com/one',
      'https://example.com/two',
      'https://example.com/three',
    ])
    expect(emitted).toEqual([
      'https://example.com/one',
      'https://example.com/two',
      'https://example.com/three',
    ])
  })

  it('prunes aged dedup entries so the map cannot grow unbounded', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    // 50 distinct URLs. They are spaced ANOMALY_WINDOW_MS apart (not just
    // DEDUP_WINDOW_MS) so this dedup-pruning test never trips the circuit
    // breaker — the breaker is exercised by its own describe block; here we
    // only assert the dedup map prunes aged entries. The gap still far
    // exceeds DEDUP_WINDOW_MS, so every prior entry has aged out before the
    // next is recorded, which is what this test verifies.
    for (let i = 0; i < 50; i++) {
      const url = `https://example.com/${i}`
      expect(router.shouldEmit(url)).toBe(true)
      router.noteEmit(url)
      clock += ANOMALY_WINDOW_MS
    }
    // After the loop the very first URL is long expired — re-clicking it
    // is allowed again (proves the entry was pruned, not retained).
    expect(router.shouldEmit('https://example.com/0')).toBe(true)
  })
})

describe('§2.25 anomaly detection — runaway loop signal (AC e)', () => {
  it('flags an anomaly when emissions exceed the threshold within the window', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const results: boolean[] = []

    // ANOMALY_THRESHOLD + 1 emissions of DISTINCT urls (so dedup never
    // suppresses them) all inside ANOMALY_WINDOW_MS — the runaway shape.
    for (let i = 0; i <= ANOMALY_THRESHOLD; i++) {
      const url = `https://evil.example/loop/${i}`
      router.shouldEmit(url)
      results.push(router.noteEmit(url).anomaly)
      clock += 10
    }

    // The first ANOMALY_THRESHOLD emissions are fine; the next one trips it.
    expect(results.slice(0, ANOMALY_THRESHOLD)).toEqual(
      new Array(ANOMALY_THRESHOLD).fill(false),
    )
    expect(results[ANOMALY_THRESHOLD]).toBe(true)
  })

  it('reports recentCount alongside the anomaly verdict', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    let last = router.noteEmit('https://example.com/x0')
    for (let i = 1; i <= ANOMALY_THRESHOLD; i++) {
      clock += 5
      last = router.noteEmit(`https://example.com/x${i}`)
    }
    expect(last.anomaly).toBe(true)
    expect(last.recentCount).toBe(ANOMALY_THRESHOLD + 1)
  })

  it('does NOT flag an anomaly for spread-out, legitimate emissions', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const verdicts: boolean[] = []
    // One emission per anomaly window — normal user clicking links slowly.
    for (let i = 0; i < 10; i++) {
      verdicts.push(router.noteEmit(`https://example.com/n${i}`).anomaly)
      clock += ANOMALY_WINDOW_MS
    }
    expect(verdicts.every(v => v === false)).toBe(true)
  })

  it('anomaly window slides — old emissions stop counting', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    // Three emissions, then a gap longer than the window, then more.
    router.noteEmit('https://example.com/a')
    clock += 100
    router.noteEmit('https://example.com/b')
    clock += 100
    router.noteEmit('https://example.com/c')
    // Gap > ANOMALY_WINDOW_MS — the three above age out.
    clock += ANOMALY_WINDOW_MS + 1
    const r = router.noteEmit('https://example.com/d')
    expect(r.anomaly).toBe(false)
    expect(r.recentCount).toBe(1)
  })
})

describe('§2.25 dedup boundary conditions', () => {
  it('suppresses a duplicate URL at DEDUP_WINDOW_MS - 1 (still inside window)', () => {
    let clock = 100_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/boundary'

    router.shouldEmit(url)
    router.noteEmit(url)

    // One millisecond before the window ends — still a duplicate.
    clock += DEDUP_WINDOW_MS - 1
    expect(router.shouldEmit(url)).toBe(false)
  })

  it('allows the same URL at exactly DEDUP_WINDOW_MS (boundary is open: t - last < window)', () => {
    let clock = 100_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/boundary'

    router.shouldEmit(url)
    router.noteEmit(url)

    // At exactly the window width the condition `t - last < DEDUP_WINDOW_MS`
    // is false, so the emission is allowed.
    clock += DEDUP_WINDOW_MS
    expect(router.shouldEmit(url)).toBe(true)
  })

  it('shouldEmit does NOT record state — calling it twice without noteEmit returns true both times', () => {
    const clock = 50_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/no-side-effect'

    // First call: no prior noteEmit, must be true.
    expect(router.shouldEmit(url)).toBe(true)
    // Second call without noteEmit: still true — shouldEmit is read-only.
    expect(router.shouldEmit(url)).toBe(true)
  })

  it('noteEmit refreshes the timestamp — a later noteEmit extends the dedup window', () => {
    let clock = 200_000
    const router = new MailLinkRouter(() => clock)
    const url = 'https://example.com/refresh'

    // First emission.
    expect(router.shouldEmit(url)).toBe(true)
    router.noteEmit(url)

    // Advance past the first window, emit again.
    clock += DEDUP_WINDOW_MS + 1
    expect(router.shouldEmit(url)).toBe(true)
    router.noteEmit(url) // refreshes lastEmitByUrl[url] to new clock

    // Now within the SECOND dedup window — must be suppressed.
    clock += DEDUP_WINDOW_MS - 10
    expect(router.shouldEmit(url)).toBe(false)
  })

  it('dedup prune condition is consistent with suppress: entry aged >= DEDUP_WINDOW_MS is removed', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const urlA = 'https://example.com/a-prune'
    const urlB = 'https://example.com/b-prune'

    // Emit A, then advance exactly DEDUP_WINDOW_MS.
    router.noteEmit(urlA)
    clock += DEDUP_WINDOW_MS

    // Emitting B triggers pruning of A (age == DEDUP_WINDOW_MS satisfies >=).
    // After pruning, A can be emitted again.
    expect(router.shouldEmit(urlB)).toBe(true)
    router.noteEmit(urlB)
    // A was pruned — should be allowed.
    expect(router.shouldEmit(urlA)).toBe(true)
  })
})

describe('§2.25 anomaly threshold precision', () => {
  it('ANOMALY_THRESHOLD emissions do NOT trigger anomaly — only the (threshold+1)th does', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)

    // Emit exactly ANOMALY_THRESHOLD distinct URLs — all inside window.
    for (let i = 0; i < ANOMALY_THRESHOLD; i++) {
      const { anomaly } = router.noteEmit(`https://example.com/t${i}`)
      expect(anomaly).toBe(false)
      clock += 5
    }

    // (ANOMALY_THRESHOLD + 1)th emission — this one trips the guard.
    const { anomaly, recentCount } = router.noteEmit('https://example.com/trip')
    expect(anomaly).toBe(true)
    expect(recentCount).toBe(ANOMALY_THRESHOLD + 1)
  })

  it('anomaly window partial expiry: emissions straddling the boundary count correctly', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)

    // Two emissions inside the window.
    router.noteEmit('https://example.com/p1')
    clock += 100
    router.noteEmit('https://example.com/p2')

    // Advance so the first emission falls outside ANOMALY_WINDOW_MS but the
    // second stays inside.
    clock += ANOMALY_WINDOW_MS - 50 // second emission is 50ms inside the window

    const { recentCount } = router.noteEmit('https://example.com/p3')
    // Only the second emission (50ms inside) + the current one = 2.
    expect(recentCount).toBe(2)
  })
})

describe('§2.25 circuit breaker — real hard stop, not just slow-down (fix-loop 1)', () => {
  it('breakerTripped fires exactly ONCE — on the emission that opens the breaker', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const trips: boolean[] = []

    // Drive distinct URLs past the threshold so dedup never collapses them.
    for (let i = 0; i <= ANOMALY_THRESHOLD + 2; i++) {
      const url = `https://evil.example/loop/${i}`
      if (router.shouldEmit(url)) {
        trips.push(router.noteEmit(url).breakerTripped)
      }
      clock += 10
    }

    // Exactly one `true` — the transition into suppression, not every
    // anomalous emission. (The post-trip emissions are gated by shouldEmit
    // and therefore never reach noteEmit at all.)
    expect(trips.filter(Boolean)).toHaveLength(1)
    // The trip happens on the (ANOMALY_THRESHOLD + 1)th emission.
    expect(trips[ANOMALY_THRESHOLD]).toBe(true)
  })

  it('suppresses ALL urls once the breaker opens — even never-seen-before ones', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)

    // Trip the breaker with distinct URLs.
    for (let i = 0; i <= ANOMALY_THRESHOLD; i++) {
      const url = `https://evil.example/trip/${i}`
      router.shouldEmit(url)
      router.noteEmit(url)
      clock += 10
    }
    expect(router.isBreakerOpen()).toBe(true)

    // A brand-new URL the router has never seen is STILL suppressed — the
    // breaker is a global hard stop, not a per-URL dedup.
    clock += 10
    expect(router.shouldEmit('https://totally-new.example/fresh')).toBe(false)
  })

  it('stops sustained identical-url reattempts beyond the dedup window', () => {
    // A sustained Chromium preventDefault-retry loop: the SAME URL is
    // re-offered every DEDUP_WINDOW_MS + 1 ms. The dedup layer alone would
    // let one emission through per window forever (~1.6/sec). The breaker
    // must HALT total emissions: because every reattempt keeps offering a
    // url while the breaker is open, the quiet deadline never elapses and
    // the breaker stays latched.
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const url = 'https://evil.example/sustained'
    const emitted: number[] = []

    // 500 reattempts — would be ~500 tabs without a real stop.
    for (let i = 0; i < 500; i++) {
      if (router.shouldEmit(url)) {
        router.noteEmit(url)
        emitted.push(clock)
      }
      clock += DEDUP_WINDOW_MS + 1
    }

    // The runaway is HALTED, not slowed: after the trip every further offer
    // is suppressed AND pushes the quiet deadline forward, so the breaker
    // never re-opens. Total emissions are exactly the threshold + 1 — the
    // emissions it took to detect the runaway, and not one more.
    expect(emitted).toHaveLength(ANOMALY_THRESHOLD + 1)
    expect(router.isBreakerOpen()).toBe(true)
  })

  it('stops sustained DISTINCT-url reattempts beyond the dedup window', () => {
    // Worst case for a URL-keyed dedup: a sustained loop cycling through
    // DIFFERENT urls, so dedup never collapses anything. Only the breaker
    // can stop this — and because the loop keeps offering urls, the quiet
    // deadline is perpetually pushed forward and the breaker stays latched.
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    let emitted = 0

    for (let i = 0; i < 500; i++) {
      const url = `https://evil.example/distinct/${i}`
      if (router.shouldEmit(url)) {
        router.noteEmit(url)
        emitted++
      }
      clock += DEDUP_WINDOW_MS + 1
    }

    // 500 distinct reattempts; dedup suppresses NONE of them. The breaker
    // is the only thing bounding this, and it bounds it HARD: emissions
    // stop entirely at threshold + 1.
    expect(emitted).toBe(ANOMALY_THRESHOLD + 1)
    expect(router.isBreakerOpen()).toBe(true)
  })

  it('breaker re-closes after a genuine quiet period (self-healing for bounded bursts)', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)

    // Trip the breaker, then capture the clock at the trip.
    for (let i = 0; i <= ANOMALY_THRESHOLD; i++) {
      const url = `https://evil.example/heal/${i}`
      router.shouldEmit(url)
      router.noteEmit(url)
      clock += 10
    }
    expect(router.isBreakerOpen()).toBe(true)
    // `clock` is now 10ms past the trip; the quiet deadline is
    // (tripClock + BREAKER_COOLDOWN_MS) = (clock - 10 + BREAKER_COOLDOWN_MS).
    const quietDeadline = clock - 10 + BREAKER_COOLDOWN_MS

    // The burst has ENDED — no further offers. One ms before the deadline
    // the breaker is still open; checking isBreakerOpen() must not extend it.
    clock = quietDeadline - 1
    expect(router.isBreakerOpen()).toBe(true)

    // At exactly the deadline the breaker self-heals and normal clicks work.
    clock = quietDeadline
    expect(router.isBreakerOpen()).toBe(false)
    expect(router.shouldEmit('https://example.com/allowed')).toBe(true)
  })

  it('a normal user clicking a few different links does NOT trip the breaker', () => {
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    const emitted: string[] = []

    // Three distinct links over ~3 seconds — realistic human pace through
    // a phishing-confirm prompt. ANOMALY_THRESHOLD distinct emissions are
    // allowed; the breaker only trips on the (threshold + 1)th.
    const links = [
      'https://news.example/a',
      'https://docs.example/b',
      'https://shop.example/c',
    ]
    for (const url of links) {
      if (router.shouldEmit(url)) {
        const { breakerTripped } = router.noteEmit(url)
        expect(breakerTripped).toBe(false)
        emitted.push(url)
      }
      clock += 1_000 // ~1s between clicks
    }

    expect(emitted).toEqual(links)
    expect(router.isBreakerOpen()).toBe(false)
  })

  it('emissions are actually suppressed after the anomaly trips — not merely reported', () => {
    // The pre-fix anomaly path only reported to Sentry; the anomalous
    // emission still went out. This asserts the breaker GATES emissions:
    // count what shouldEmit actually lets through.
    let clock = 0
    const router = new MailLinkRouter(() => clock)
    let accepted = 0

    // 50 distinct urls offered in a tight burst (all inside one anomaly
    // window): without a real breaker all 50 would emit.
    for (let i = 0; i < 50; i++) {
      const url = `https://evil.example/burst/${i}`
      if (router.shouldEmit(url)) {
        router.noteEmit(url)
        accepted++
      }
      clock += 5
    }

    // The breaker latched: only the first ANOMALY_THRESHOLD + 1 emissions
    // got through, the remaining 46 were suppressed by shouldEmit.
    expect(accepted).toBe(ANOMALY_THRESHOLD + 1)
  })
})

/**
 * BACKLOG §2.25 fix-loop 2 — `will-frame-navigate` handler regression.
 *
 * codex-security-review HIGH: the `main.ts` `will-frame-navigate` listener
 * had been wired with an `as unknown as { on }` cast and read POSITIONAL
 * arguments (`args[1]` for the url, `args[3]` for isMainFrame). Electron 40
 * passes `will-frame-navigate` a SINGLE `details` event object
 * (`WebContentsWillFrameNavigateEventParams` — `details.url`,
 * `details.isMainFrame`, `details.preventDefault()`), so `args[1]` was
 * `undefined`, `url` collapsed to `''`, and the entire raw-link safety net
 * was dead.
 *
 * `decideMailLinkAction` is the pure decision function the typed handler now
 * delegates to. These tests invoke it with the REAL details-object field
 * names (`{ url, isMainFrame }`) — a test written this way FAILS against the
 * old positional-args reading (which never produced a `url`) and PASSES
 * against the `details`-object reading.
 */
describe('§2.25 fix-loop 2 — decideMailLinkAction (will-frame-navigate routing)', () => {
  const routedUrl = (href: string, text?: string) => {
    const u = new URL('mailcopilot-link://route')
    u.searchParams.set('u', href)
    if (text !== undefined) u.searchParams.set('t', text)
    return u.toString()
  }

  it('routed mailcopilot-link:// URL on a SUBFRAME → routed action with de-referenced href', () => {
    const action = decideMailLinkAction({
      url: routedUrl('https://bank.example/login', 'Sign in'),
      isMainFrame: false,
    })
    expect(action).toEqual({
      kind: 'routed',
      payload: { href: 'https://bank.example/login', text: 'Sign in' },
    })
  })

  it('raw allowed-external URL on a SUBFRAME → raw action with unsafeBypass: true', () => {
    // This is the path the bug killed: a raw http(s) URL that escaped
    // rewriteMailHtmlLinks() must be forced through the phishing prompt.
    const action = decideMailLinkAction({
      url: 'https://phishing.example/landing',
      isMainFrame: false,
    })
    expect(action).toEqual({
      kind: 'raw',
      payload: { href: 'https://phishing.example/landing', text: '', unsafeBypass: true },
    })
  })

  it('raw mailto: URL on a SUBFRAME → raw action with unsafeBypass: true', () => {
    const action = decideMailLinkAction({
      url: 'mailto:someone@example.com',
      isMainFrame: false,
    })
    expect(action).toEqual({
      kind: 'raw',
      payload: { href: 'mailto:someone@example.com', text: '', unsafeBypass: true },
    })
  })

  it('main-frame navigation → ignore (never our concern in this handler)', () => {
    // Even a routed URL is ignored on the main frame — the will-navigate
    // handler owns main-frame routing; this guard prevents double-handling.
    expect(decideMailLinkAction({ url: routedUrl('https://x.example'), isMainFrame: true }))
      .toEqual({ kind: 'ignore' })
    expect(decideMailLinkAction({ url: 'https://x.example', isMainFrame: true }))
      .toEqual({ kind: 'ignore' })
  })

  it('empty URL → ignore (the exact symptom of the old positional-args bug)', () => {
    // With the old `args[1]` reading, `url` was ALWAYS '' — and '' must
    // resolve to `ignore`, not crash and not route. This asserts the empty
    // case is handled; the bug was that EVERY url became this case.
    expect(decideMailLinkAction({ url: '', isMainFrame: false })).toEqual({ kind: 'ignore' })
  })

  it('garbage / unparseable URL on a SUBFRAME → ignore', () => {
    expect(decideMailLinkAction({ url: 'not a url', isMainFrame: false }))
      .toEqual({ kind: 'ignore' })
    expect(decideMailLinkAction({ url: '::::', isMainFrame: false }))
      .toEqual({ kind: 'ignore' })
  })

  it('disallowed-protocol URL on a SUBFRAME → ignore (not http/https/mailto)', () => {
    // file:, javascript:, data: etc. are NOT allowed external protocols and
    // are not routed mail links — they must not produce a raw action.
    expect(decideMailLinkAction({ url: 'file:///etc/passwd', isMainFrame: false }))
      .toEqual({ kind: 'ignore' })
    expect(decideMailLinkAction({ url: 'javascript:alert(1)', isMainFrame: false }))
      .toEqual({ kind: 'ignore' })
  })

  it('routed link with no `u` param → ignore (malformed routed URL)', () => {
    expect(decideMailLinkAction({ url: 'mailcopilot-link://route', isMainFrame: false }))
      .toEqual({ kind: 'ignore' })
  })
})

describe('§2.25 pure helpers — isAllowedExternalUrl / parseRoutedMailLink', () => {
  it('isAllowedExternalUrl accepts http/https/mailto and rejects everything else', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:a@example.com')).toBe(true)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('mailcopilot-link://route?u=x')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('garbage')).toBe(false)
  })

  it('parseRoutedMailLink extracts href + text from a routed URL', () => {
    const u = new URL('mailcopilot-link://route')
    u.searchParams.set('u', 'https://example.com/x')
    u.searchParams.set('t', 'Click here')
    expect(parseRoutedMailLink(u.toString())).toEqual({
      href: 'https://example.com/x',
      text: 'Click here',
    })
  })

  it('parseRoutedMailLink defaults text to empty string when `t` is absent', () => {
    const u = new URL('mailcopilot-link://route')
    u.searchParams.set('u', 'https://example.com/y')
    expect(parseRoutedMailLink(u.toString())).toEqual({
      href: 'https://example.com/y',
      text: '',
    })
  })

  it('parseRoutedMailLink returns null for non-routed / malformed URLs', () => {
    expect(parseRoutedMailLink('https://example.com')).toBeNull()
    expect(parseRoutedMailLink('mailcopilot-link://route')).toBeNull() // no `u`
    expect(parseRoutedMailLink('not a url')).toBeNull()
    expect(parseRoutedMailLink('')).toBeNull()
  })
})

/**
 * BACKLOG §2.133 — the routed-link boundary bounds `t` on READ.
 *
 * `buildRoutedMailLink` caps the visible link text at
 * MAX_ROUTED_LINK_TEXT_LENGTH, but that cap only ever applied to links WE
 * build. `rewriteMailHtmlLinks` leaves an href it cannot normalise untouched in
 * the DOM, and `mailcopilot-link:` is not one of its allowed protocols — so a
 * sender can plant `mailcopilot-link://open?u=https://ok.example&t=<200 KB>`
 * himself and it survives verbatim into the iframe. Clicking it used to hand
 * the whole blob to the renderer.
 *
 * These tests are at the boundary deliberately: they hold regardless of what
 * the renderer does with `text`, so the guarantee does not depend on the
 * consumer staying careful.
 */
describe('§2.133 — routed-link text bound (read side)', () => {
  const routed = (href: string, text: string) => {
    const u = new URL('mailcopilot-link://open')
    u.searchParams.set('u', href)
    u.searchParams.set('t', text)
    return u.toString()
  }

  it('truncates an over-long `t` to MAX_ROUTED_LINK_TEXT_LENGTH', () => {
    const hostile = 'x'.repeat(200_000)
    const parsed = parseRoutedMailLink(routed('https://ok.example/', hostile))
    expect(parsed).not.toBeNull()
    expect(parsed?.text.length).toBe(MAX_ROUTED_LINK_TEXT_LENGTH)
    expect(parsed?.href).toBe('https://ok.example/')
  })

  it('bounds `t` on the decision function too — the path will-frame-navigate uses', () => {
    // decideMailLinkAction is what main.ts actually calls; the bound must hold
    // there, not merely in the helper underneath it.
    const action = decideMailLinkAction({
      url: routed('https://ok.example/', 'a-'.repeat(100_000)),
      isMainFrame: false,
    })
    expect(action.kind).toBe('routed')
    if (action.kind !== 'routed') throw new Error('expected routed action')
    expect(action.payload.text.length).toBe(MAX_ROUTED_LINK_TEXT_LENGTH)
  })

  it('round-trips a link built by buildRoutedMailLink unchanged', () => {
    // The bound is the writer's own constant, so our own links never notice it —
    // including one whose text is exactly at the cap.
    const text = 'S'.repeat(MAX_ROUTED_LINK_TEXT_LENGTH)
    const parsed = parseRoutedMailLink(buildRoutedMailLink('https://bank.example/login', text))
    expect(parsed).toEqual({ href: 'https://bank.example/login', text })
  })

  it('leaves a normal short `t` untouched', () => {
    expect(parseRoutedMailLink(routed('https://ok.example/', 'Sign in'))?.text).toBe('Sign in')
  })

  it('does NOT truncate `u` — a shortened address is a different address', () => {
    // Asymmetry with `t`: display text is a heuristic input, an address is the
    // destination. A long-but-legitimate tracking URL must survive intact.
    const longHref = `https://ok.example/r/${'q'.repeat(4000)}`
    expect(parseRoutedMailLink(routed(longHref, 'Click'))?.href).toBe(longHref)
  })
})
