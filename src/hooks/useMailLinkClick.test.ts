// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useMailLinkClick.ts
 *
 * Tests cover:
 *   - Safe link (https, matching text) → opens directly via ui:openExternal, no prompt
 *   - mailto: → opens directly, no prompt
 *   - http: (unencrypted) → prompt with warningHttp
 *   - IDN/punycode hostname → prompt with warningIdn
 *   - Display-text host mismatch → prompt with warningMismatch
 *   - unsafeBypass=true → prompt forced even for clean https URL
 *   - stacked warnings (http + unsafeBypass) → multiple entries
 *   - dismissPrompt clears the prompt
 *   - approvePrompt calls ui:openExternal and clears prompt
 *   - mail:link IPC listener registered on mount / cleaned up on unmount
 *   - malformed mail:link payload is silently ignored
 *   - onOpenExternalError callback is called on IPC failure
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMailLinkClick } from './useMailLinkClick'

// ---------------------------------------------------------------------------
// i18n mock — stable for all tests
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'mail.links.warningHttp': 'The link uses http (not encrypted).',
  'mail.links.warningIdn': 'IDN domain: {{unicode}} ({{ascii}}).',
  'mail.links.warningIdnSimple': 'IDN domain (punycode): {{ascii}}.',
  'mail.links.warningMismatch': 'Link text shows {{shown}}, goes to {{real}}.',
  'mail.links.warningRawExternalLink': 'This link bypassed the URL rewriter.',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  const val = i18nMap[key] ?? key
  if (!opts) return val
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts[k] !== undefined ? String(opts[k]) : `{{${k}}}`))
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------
const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a mail:link IPC event via the registered listener. */
function fireMailLink(payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  const call = calls.find(([ch]) => ch === 'mail:link')
  call?.[1]?.(payload)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMailLinkClick — safe link', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('opens a clean https link directly via ui:openExternal, no prompt', async () => {
    const { result } = renderHook(() => useMailLinkClick())
    expect(result.current.linkPrompt).toBeNull()

    await act(async () => {
      await result.current.handleLinkClick('https://example.com', 'example.com')
    })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://example.com/')
  })

  it('opens mailto: directly without prompt', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('mailto:alice@example.com', '')
    })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'mailto:alice@example.com')
  })

  it('ignores empty href silently', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => { await result.current.handleLinkClick('', '') })
    await act(async () => { await result.current.handleLinkClick('#anchor', '') })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })
})

describe('useMailLinkClick — http warning', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('shows prompt with warningHttp for http: links', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('http://example.com', 'example.com')
    })

    expect(result.current.linkPrompt).not.toBeNull()
    expect(result.current.linkPrompt?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('not encrypted')]),
    )
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })
})

describe('useMailLinkClick — mismatch warning', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('shows prompt with warningMismatch when display text host differs from real host', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://evil.com/steal', 'paypal.com')
    })

    expect(result.current.linkPrompt).not.toBeNull()
    const warnings = result.current.linkPrompt?.warnings ?? []
    expect(warnings.some(w => w.includes('paypal.com') || w.includes('evil.com'))).toBe(true)
  })

  it('does NOT show mismatch prompt when www. prefix is the only difference', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://www.example.com', 'example.com')
    })

    // stripWww should normalise both sides — no mismatch.
    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://www.example.com/')
  })
})

/**
 * BACKLOG §2.133 — the display-text host extraction must stay linear, and must
 * keep detecting exactly the shapes it detected before.
 *
 * The old implementation was an unanchored regex with a nested quantifier
 * (`/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i`). Text without a dot made the engine
 * restart at every offset and rescan to the end from each — quadratic, and
 * `text` comes straight out of a mail body via the `mail:link` payload, so a
 * remote sender could freeze the renderer's main thread with one crafted link.
 */
describe('useMailLinkClick — §2.133 host extraction (ReDoS regression)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  // HOW THE INPUT SIZE AND THRESHOLD BELOW WERE CHOSEN — read before changing
  // either, and especially before "just raising the number" after a red run.
  //
  // What this guards is a COMPLEXITY CLASS — quadratic versus linear — not a
  // latency budget. Nobody ships a slightly-slow version of this function: the
  // scan either is single-pass or it backtracks. So the only property the
  // threshold needs is to sit in the empty space between the two populations,
  // and the width of that space is a function of the INPUT SIZE, not of how
  // carefully the number is tuned.
  //
  // That is what the first version of this test got wrong. At 50 KB it asserted
  // < 100 ms and failed a pre-commit `npm test` at 147.9 ms with 197 files
  // running in parallel — it was reporting scheduler contention. But the fix is
  // not a bigger number at 50 KB, because at 50 KB the populations are barely
  // apart at all. Measured on this code path (12-core box, min-of-3):
  //
  //                          50 KB input          200 KB input
  //   fixed (single pass)    6.6 ms idle          30.9 ms idle
  //                          up to 379 ms loaded  up to 97.9 ms loaded (*)
  //   broken (old regex)     1 345 ms             21 923 ms
  //   separation             ~4×                  ~224×
  //
  // (*) not a typo: the 200 KB figure is min-of-3, the 50 KB one is a worst
  // single sample from an earlier round; both are healthy-population maxima
  // observed under a concurrently running full suite.
  //
  // Quadratic cost grows 16× when the input grows 4×; linear cost grows 4×. So
  // quadrupling the input turns a hopeless ~4× gap into a ~224× one. A 50 KB
  // test cannot be made reliable at any threshold — verified directly: with the
  // old regex restored, the 50 KB test PASSED at 1 561 ms against a 2 500 ms
  // bar. It is the input that discriminates, not the constant.
  //
  // 1 500 ms is the geometric midpoint of the 200 KB populations
  // (√(97.9 × 21923) ≈ 1 465): ~15× above the worst healthy run observed under
  // load, ~15× below the broken one. Both margins are an order of magnitude, so
  // contention cannot cross it and no regression of this class can hide under
  // it. If it ever fails, look at the reported number before touching the
  // constant: ~100 ms means noise nobody has seen yet, ~20 s means the ReDoS is
  // back, and anything in between means something genuinely new.
  //
  // Min-of-3 rather than a single sample: under load, individual samples on
  // this path were observed spanning 5.9–379 ms within one run: contention can
  // only ever make a sample slower, so the fastest of several is the closest
  // estimate of the real cost, and one preempted sample cannot fail the build.
  //
  // The assertion is deliberately NOT split into "tight on the pure extraction,
  // loose on the hook". Measured attribution of the cost says the React/`act()`
  // wrapper is not the variable part: of ~30 ms at 50 KB, ~25–34 ms is the
  // failing `new URL()` parse of the string *inside* extractHostFromText,
  // 0.3–9 ms is the scan, and 0.7–1.7 ms is all of React — the wrapper is ~3%.
  // Splitting would move 3% of the measurement out and cost a widened
  // production API (extractHostFromText is module-private), while the hook path
  // is what production actually runs.
  //
  // The explicit 60 s test timeout is part of the guard, not padding: at the 5 s
  // vitest default a quadratic regression dies as an opaque timeout and the
  // number that identifies it — "expected 21922 to be less than 1500" — is
  // never printed. Let the measurement finish and let the assertion report it.
  const MAX_EXTRACTION_MS = 1_500

  it('handles a 200 KB adversarial display text in linear time', async () => {
    // 200 000 host-alphabet characters with no dot anywhere: the worst case for
    // the old pattern — every start offset matched the whole remainder, then
    // failed looking for a `.`.
    const hostile = 'x'.repeat(200_000) + '!'
    const { result } = renderHook(() => useMailLinkClick())

    let bestMs = Infinity
    for (let sample = 0; sample < 3; sample++) {
      const started = performance.now()
      await act(async () => {
        await result.current.handleLinkClick('https://example.com', hostile)
      })
      bestMs = Math.min(bestMs, performance.now() - started)
      // Already over budget on the fastest sample so far — the remaining ones
      // cannot bring the minimum down, and against a quadratic implementation
      // each costs another ~22 s. Report now.
      if (bestMs > MAX_EXTRACTION_MS) break
    }

    expect(bestMs).toBeLessThan(MAX_EXTRACTION_MS)
    // No dot in the text → no host claim → no mismatch warning, link opens.
    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://example.com/')
  }, 60_000)

  it('still finds the host when it is buried at the end of a long text', async () => {
    // Guards against "fixed" by capping the scan: the mismatch warning must
    // still fire for a host that only appears late in the text.
    const text = `${'padding word '.repeat(2000)}evil.example`
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://bank.example/login', text)
    })

    expect(result.current.linkPrompt?.warnings.join(' ')).toContain('shows evil.example')
  })

  // Every realistic display-text shape the mismatch heuristic fires on today.
  // `href` is always a bank-looking URL, so a detected host claim ALWAYS
  // mismatches — the assertion is about which host was extracted.
  const MISMATCH_SHAPES: Array<[label: string, text: string, shown: string]> = [
    ['bare host', 'evil.example', 'evil.example'],
    ['full URL', 'https://evil.example/path?a=1', 'evil.example'],
    ['http URL', 'http://evil.example/', 'evil.example'],
    ['www-prefixed host', 'www.evil.example', 'www.evil.example'],
    ['host with path, no scheme', 'evil.example/login', 'evil.example'],
    ['host mid-sentence', 'Please visit evil.example today', 'evil.example'],
    ['host at end of a sentence', 'More at evil.example.', 'evil.example'],
    ['host inside an email address', 'write to admin@evil.example', 'evil.example'],
    ['uppercase host', 'EVIL.EXAMPLE', 'EVIL.EXAMPLE'],
    ['subdomain chain', 'login.secure.evil.example', 'login.secure.evil.example'],
    ['hyphenated labels', 'my-bank-login.evil-host.example', 'my-bank-login.evil-host.example'],
    ['IPv4 literal', 'go to 192.168.0.1 now', '192.168.0.1'],
    ['host in parentheses', '(evil.example)', 'evil.example'],
    ['leading dot', '.evil.example', 'evil.example'],
    ['empty label before the host', 'a..b then evil.example', 'evil.example'],
    ['host after a slash-separated word', 'either/or evil.example', 'evil.example'],
  ]

  it.each(MISMATCH_SHAPES)('mismatch warning still fires for %s', async (_label, text, shown) => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://bank.example/login', text)
    })

    expect(result.current.linkPrompt).not.toBeNull()
    expect(result.current.linkPrompt?.warnings.join(' '))
      .toContain(`shows ${shown}, goes to bank.example`)
  })

  // Shapes that carry no host claim: the heuristic must stay silent, otherwise
  // every plain "Click here" link would grow a false phishing warning.
  const NO_HOST_SHAPES: Array<[label: string, text: string]> = [
    ['plain words', 'Click here'],
    ['single word with a trailing dot', 'here.'],
    ['dots only', '...'],
    ['empty labels around a dot', 'a..b'],
    ['non-ASCII text', 'нажмите здесь'],
    ['underscore-separated word', 'click_here'],
  ]

  it.each(NO_HOST_SHAPES)('no mismatch warning for %s', async (_label, text) => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://bank.example/login', text)
    })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://bank.example/login')
  })
})

describe('useMailLinkClick — IDN warning', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('shows prompt with warningIdn when hostname contains xn--', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ui:domainToUnicode') return Promise.resolve({ unicode: 'pаypal.com', ascii: 'xn--pypal-4ve.com' })
      return Promise.resolve(undefined)
    })

    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://xn--pypal-4ve.com', '')
    })

    expect(result.current.linkPrompt).not.toBeNull()
    const warnings = result.current.linkPrompt?.warnings ?? []
    expect(warnings.some(w => w.toLowerCase().includes('idn') || w.includes('xn--'))).toBe(true)
  })

  it('falls back to warningIdnSimple when ui:domainToUnicode IPC throws', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ui:domainToUnicode') return Promise.reject(new Error('IPC error'))
      return Promise.resolve(undefined)
    })

    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://xn--pypal-4ve.com', '')
    })

    expect(result.current.linkPrompt).not.toBeNull()
    const warnings = result.current.linkPrompt?.warnings ?? []
    expect(warnings.some(w => w.includes('xn--pypal-4ve.com'))).toBe(true)
  })
})

describe('useMailLinkClick — unsafeBypass', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('forces prompt for clean https URL with empty text when unsafeBypass=true', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('https://example.com', '', true)
    })

    expect(result.current.linkPrompt).not.toBeNull()
    const warnings = result.current.linkPrompt?.warnings ?? []
    expect(warnings.some(w => w.includes('URL rewriter') || w.includes('bypass'))).toBe(true)
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })

  it('stacks http + unsafeBypass warnings into two distinct entries', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('http://example.com', '', true)
    })

    expect(result.current.linkPrompt).not.toBeNull()
    expect((result.current.linkPrompt?.warnings ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('useMailLinkClick — prompt lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('dismissPrompt clears linkPrompt without calling openExternal', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('http://unsafe.com', '')
    })
    expect(result.current.linkPrompt).not.toBeNull()

    act(() => { result.current.dismissPrompt() })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })

  it('approvePrompt calls ui:openExternal and clears prompt', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      await result.current.handleLinkClick('http://unsafe.com', '')
    })
    expect(result.current.linkPrompt).not.toBeNull()

    await act(async () => { await result.current.approvePrompt() })

    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'http://unsafe.com/')
    expect(result.current.linkPrompt).toBeNull()
  })
})

describe('useMailLinkClick — mail:link IPC listener', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('registers mail:link listener on mount', () => {
    renderHook(() => useMailLinkClick())
    const calls = mockOn.mock.calls as Array<[string, unknown]>
    expect(calls.some(([ch]) => ch === 'mail:link')).toBe(true)
  })

  it('unregisters mail:link listener on unmount', () => {
    const { unmount } = renderHook(() => useMailLinkClick())
    unmount()
    const calls = mockOff.mock.calls as Array<[string, unknown]>
    expect(calls.some(([ch]) => ch === 'mail:link')).toBe(true)
  })

  it('processes mail:link IPC payload and opens safe link', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      fireMailLink({ href: 'https://example.com', text: 'example.com' })
    })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).toHaveBeenCalledWith('ui:openExternal', 'https://example.com/')
  })

  it('processes mail:link IPC payload with unsafeBypass=true and shows prompt', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      fireMailLink({ href: 'https://example.com', text: '', unsafeBypass: true })
    })

    expect(result.current.linkPrompt).not.toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })

  it('silently ignores malformed payload (missing href)', async () => {
    const { result } = renderHook(() => useMailLinkClick())

    await act(async () => {
      fireMailLink({ text: 'no href' })
      fireMailLink('not an object')
      fireMailLink(null)
    })

    expect(result.current.linkPrompt).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('ui:openExternal', expect.anything())
  })

  // BACKLOG §2.25 regression: the subscription must be mount-once. Before the
  // fix, the effect depended on `handleLinkClick`, whose identity changes every
  // render (it closes over the caller's `onOpenExternalError`), so each render
  // resubscribed. Because preload `off()` cannot remove a contextBridge-proxied
  // listener by identity, every render leaked another live listener and one
  // click fanned out into many `ui:openExternal` calls → many browser tabs.
  it('subscribes to mail:link exactly once across re-renders with changing callback identity', () => {
    let renderCount = 0
    const { rerender } = renderHook(() => {
      renderCount++
      // New inline callback identity on every render — the exact trigger.
      return useMailLinkClick((msg) => void msg)
    })

    rerender()
    rerender()
    rerender()
    expect(renderCount).toBeGreaterThan(1)

    const mailLinkSubs = (mockOn.mock.calls as Array<[string, unknown]>)
      .filter(([ch]) => ch === 'mail:link')
    expect(mailLinkSubs).toHaveLength(1)
  })

  it('delivers exactly one ui:openExternal per mail:link event even after many re-renders', async () => {
    const { rerender } = renderHook(() => useMailLinkClick((msg) => void msg))
    for (let i = 0; i < 10; i++) rerender()

    // Real fan-out guard: invoke EVERY registered mail:link listener (not just
    // the first), modelling the old leak where each render added another live
    // listener — preload `off()` cannot remove a contextBridge listener by
    // identity, so they all fire. With the mount-once fix exactly one listener
    // is registered, so exactly one ui:openExternal is dispatched. Against the
    // old deps:[handleLinkClick] code, 11 listeners would fire → 11 opens.
    const allLinkListeners = (mockOn.mock.calls as Array<[string, (p: unknown) => void]>)
      .filter(([ch]) => ch === 'mail:link')
      .map(([, fn]) => fn)
    await act(async () => {
      for (const fn of allLinkListeners) fn({ href: 'https://example.com', text: 'example.com' })
    })

    const openCalls = mockInvoke.mock.calls.filter(([ch]) => ch === 'ui:openExternal')
    expect(openCalls).toHaveLength(1)
  })
})

describe('useMailLinkClick — onOpenExternalError callback', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('calls onOpenExternalError when ui:openExternal IPC throws', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC failure'))
    const onError = vi.fn()
    const { result } = renderHook(() => useMailLinkClick(onError))

    await act(async () => {
      await result.current.handleLinkClick('https://example.com', 'example.com')
    })

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('IPC failure'))
  })

  it('does not throw when onOpenExternalError is not provided', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC failure'))
    const { result } = renderHook(() => useMailLinkClick())

    // Should not throw
    await expect(
      act(async () => {
        await result.current.handleLinkClick('https://example.com', 'example.com')
      })
    ).resolves.not.toThrow()
  })
})
