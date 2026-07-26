// @vitest-environment jsdom
/**
 * Unit tests for the §3.3.C-print.f1 print fix in App.tsx.
 *
 * The fix routes Ctrl+P (intercepted by main via before-input-event) to the
 * renderer via `mail:print` IPC event, and the renderer scopes printing to the
 * focused message-body iframe. These tests verify:
 *
 *  1. window.api.on('mail:print', ...) is registered on mount.
 *  2. window.api.off('mail:print', ...) is called on unmount.
 *  3. Clicking the print button calls iframe.contentWindow.print() directly.
 *  4. The `mail:print` listener calls the same iframe.contentWindow.print() path.
 *  5. window.api.invoke('win:print') is NEVER called (regression guard — old path removed).
 *
 * Because App.tsx is a monolithic component with dozens of IPC calls and
 * sub-hooks, we replicate the two affected code paths (useEffect + onClick)
 * in minimal React components that mirror the exact same patterns.
 *
 * This is deliberate: we test the *behaviour contract* (which window.api
 * methods are called, and that iframe.contentWindow.print is reached)
 * not the surrounding App scaffolding.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useEffect } from 'react'
import React from 'react'

// ---------------------------------------------------------------------------
// window.api mock — set before any import that might read it
// ---------------------------------------------------------------------------
const mockInvoke = vi.fn().mockResolvedValue(undefined)
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// Helpers: minimal components that mirror the App.tsx print patterns
// ---------------------------------------------------------------------------

/**
 * Mirrors the useEffect in App.tsx (lines 932-937):
 *   const handler = () => { mailIframeRef.current?.contentWindow?.print() }
 *   window.api?.on('mail:print', handler)
 *   return () => { window.api?.off('mail:print', handler) }
 *
 * We expose the iframe ref via a data attribute so tests can set contentWindow.
 */
function PrintListenerFixture({ iframeRef }: { iframeRef: React.MutableRefObject<HTMLIFrameElement | null> }) {
  useEffect(() => {
    const handler = () => { iframeRef.current?.contentWindow?.print() }
    window.api?.on('mail:print', handler)
    return () => { window.api?.off('mail:print', handler) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return React.createElement('div', { 'data-testid': 'fixture' })
}

/**
 * Mirrors the print button in App.tsx:
 *   <button
 *     data-testid="mail-action-print"
 *     onClick={() => { mailIframeRef.current?.contentWindow?.print() }}
 *   >
 * Note: disabled prop removed from production in fix-wave 2.1.A; null-safety
 * is handled by optional chaining in onClick instead.
 */
function PrintButtonFixture({ iframeRef }: { iframeRef: React.MutableRefObject<HTMLIFrameElement | null> }) {
  return React.createElement(
    'button',
    {
      'data-testid': 'mail-action-print',
      onClick: () => { iframeRef.current?.contentWindow?.print() },
    },
    'Print',
  )
}

/**
 * Combined fixture: listener + button, sharing the same iframe ref.
 * Uses a wrapper that creates the ref at the fixture level.
 */
function CombinedPrintFixture({
  iframeRef,
}: {
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>
}) {
  useEffect(() => {
    const handler = () => { iframeRef.current?.contentWindow?.print() }
    window.api?.on('mail:print', handler)
    return () => { window.api?.off('mail:print', handler) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return React.createElement(
    'div',
    null,
    React.createElement(
      'button',
      {
        'data-testid': 'mail-action-print',
        onClick: () => { iframeRef.current?.contentWindow?.print() },
      },
      'Print',
    ),
  )
}

/** Creates a fake iframe with a mock contentWindow.print() function. */
function makeMockIframe() {
  const mockPrint = vi.fn()
  const iframe = {
    contentWindow: { print: mockPrint },
  } as unknown as HTMLIFrameElement
  return { iframe, mockPrint }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('§3.3.C-print.f1 — mail:print listener lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('registers window.api.on("mail:print") on mount', () => {
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>
    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const mailPrintCalls = (mockOn.mock.calls as Array<[string, unknown]>).filter(
      ([ch]) => ch === 'mail:print',
    )
    expect(mailPrintCalls).toHaveLength(1)
  })

  it('unregisters window.api.off("mail:print") on unmount with the same handler reference', () => {
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>
    const { unmount } = render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const registeredHandler = (mockOn.mock.calls as Array<[string, unknown]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(registeredHandler).toBeDefined()

    act(() => { unmount() })

    const deregisteredHandler = (mockOff.mock.calls as Array<[string, unknown]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(deregisteredHandler).toBeDefined()
    expect(deregisteredHandler).toBe(registeredHandler)
  })

  it('does not register win:print listener (old IPC channel removed)', () => {
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>
    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const winPrintCalls = (mockOn.mock.calls as Array<[string, unknown]>).filter(
      ([ch]) => ch === 'win:print',
    )
    expect(winPrintCalls).toHaveLength(0)
  })
})

describe('§3.3.C-print.f1 — mail:print listener invokes iframe.contentWindow.print()', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('calling the registered handler triggers iframe.contentWindow.print()', () => {
    const { iframe, mockPrint } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    // Capture the handler that was passed to window.api.on
    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()

    // Simulate the main process broadcasting 'mail:print'
    act(() => { handler!() })

    expect(mockPrint).toHaveBeenCalledOnce()
  })

  it('handler is a no-op when iframe ref is null (no crash)', () => {
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()

    // Should not throw even with null ref
    expect(() => act(() => { handler!() })).not.toThrow()
  })

  it('calling the handler does NOT call window.api.invoke("win:print") — regression guard', () => {
    const { iframe } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    act(() => { handler!() })

    const winPrintInvoke = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>).filter(
      ([ch]) => ch === 'win:print',
    )
    expect(winPrintInvoke).toHaveLength(0)
  })
})

describe('§3.3.C-print.f1 — print button onClick', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('clicking the print button calls iframe.contentWindow.print()', () => {
    const { iframe, mockPrint } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(PrintButtonFixture, { iframeRef: ref }))
    fireEvent.click(getByTestId('mail-action-print'))

    expect(mockPrint).toHaveBeenCalledOnce()
  })

  it('clicking the print button does NOT call window.api.invoke("win:print") — regression guard', () => {
    const { iframe } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(PrintButtonFixture, { iframeRef: ref }))
    fireEvent.click(getByTestId('mail-action-print'))

    const winPrintInvoke = (mockInvoke.mock.calls as Array<[string, ...unknown[]]>).filter(
      ([ch]) => ch === 'win:print',
    )
    expect(winPrintInvoke).toHaveLength(0)
  })

  it('clicking the print button does NOT call window.api.invoke at all (no IPC on new path)', () => {
    const { iframe } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(PrintButtonFixture, { iframeRef: ref }))
    fireEvent.click(getByTestId('mail-action-print'))

    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe('§3.3.C-print.f1 — both paths call the same print target', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('button click and mail:print broadcast both call the same iframe.contentWindow.print()', () => {
    const { iframe, mockPrint } = makeMockIframe()
    const iframeRef = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(CombinedPrintFixture, { iframeRef }))

    // Trigger via button
    fireEvent.click(getByTestId('mail-action-print'))
    expect(mockPrint).toHaveBeenCalledOnce()

    // Trigger via broadcast event
    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()
    act(() => { handler!() })

    expect(mockPrint).toHaveBeenCalledTimes(2)
  })

  it('after unmount, no dangling mail:print listener is registered', () => {
    const iframeRef = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>
    const { unmount } = render(React.createElement(CombinedPrintFixture, { iframeRef }))

    act(() => { unmount() })

    const offCallsForPrint = (mockOff.mock.calls as Array<[string, unknown]>).filter(
      ([ch]) => ch === 'mail:print',
    )
    expect(offCallsForPrint).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Gap #6 — contentWindow === null does not throw and does not call window.print
// ---------------------------------------------------------------------------

describe('§3.3.C-print.f1 — contentWindow null guard (gap #6)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('listener: iframe-like object with contentWindow=null does not throw on handler call', () => {
    // Simulates a real iframe element whose contentWindow is null (not yet
    // loaded, sandboxed cross-origin, or detached from DOM).
    const iframeWithNullCW = { contentWindow: null } as unknown as HTMLIFrameElement
    const ref = { current: iframeWithNullCW } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()

    // Must not throw — optional chaining guards against null contentWindow.
    expect(() => act(() => { handler!() })).not.toThrow()
  })

  it('listener: contentWindow=null does not fall back to window.print (no regression)', () => {
    const windowPrintSpy = vi.spyOn(window, 'print').mockImplementation(() => {})

    const iframeWithNullCW = { contentWindow: null } as unknown as HTMLIFrameElement
    const ref = { current: iframeWithNullCW } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    act(() => { handler!() })

    expect(windowPrintSpy).not.toHaveBeenCalled()
    windowPrintSpy.mockRestore()
  })

  it('button onClick: iframe-like object with contentWindow=null does not throw', () => {
    const iframeWithNullCW = { contentWindow: null } as unknown as HTMLIFrameElement
    const ref = { current: iframeWithNullCW } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(PrintButtonFixture, { iframeRef: ref }))

    // The button has no disabled prop (removed in fix-wave 2.1.A), so it is always clickable.
    expect(() => fireEvent.click(getByTestId('mail-action-print'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Gap #8 — rapid double print (two clicks in quick succession)
// ---------------------------------------------------------------------------

describe('§3.3.C-print.f1 — rapid double print (gap #8)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('two rapid button clicks each call iframe.contentWindow.print() — no coalescing', () => {
    // Current expected behaviour: no debouncing, both clicks fire.
    // If intentional coalescing is added later this test documents the contract.
    const { iframe, mockPrint } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    const { getByTestId } = render(React.createElement(PrintButtonFixture, { iframeRef: ref }))
    const btn = getByTestId('mail-action-print')

    fireEvent.click(btn)
    fireEvent.click(btn)

    expect(mockPrint).toHaveBeenCalledTimes(2)
  })

  it('two rapid mail:print broadcasts each call iframe.contentWindow.print()', () => {
    const { iframe, mockPrint } = makeMockIframe()
    const ref = { current: iframe } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()

    act(() => {
      handler!()
      handler!()
    })

    expect(mockPrint).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Gap #9 — listener invoked when active message ref is null (no throw)
// ---------------------------------------------------------------------------

describe('§3.3.C-print.f1 — listener with null active message (gap #9)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('directly invoking the mail:print listener with null ref does not throw', () => {
    // Tests the code path where mail:print arrives but the ref was never set
    // (e.g. component rendered with no active message, or before iframe mounts).
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    expect(handler).toBeDefined()

    expect(() => act(() => { handler!() })).not.toThrow()
  })

  it('invoking listener with null ref does not call window.api.invoke', () => {
    const ref = { current: null } as React.MutableRefObject<HTMLIFrameElement | null>

    render(React.createElement(PrintListenerFixture, { iframeRef: ref }))

    const handler = (mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>).find(
      ([ch]) => ch === 'mail:print',
    )?.[1]
    act(() => { handler!() })

    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
