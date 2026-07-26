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
