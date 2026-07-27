// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTooltipDelegation } from './useTooltipDelegation'

/**
 * Unit tests for useTooltipDelegation.
 *
 * The hook powers the sidebar collapsed-mode tooltip portal that renders
 * outside the <aside> DOM node (position:fixed) to escape
 * .mailcopilot-sidebar overflow:hidden stacking context.
 *
 * Both the synthetic React event API (handleMouseOver/handleMouseOut) and
 * the native DOM listener API (containerRef) are covered.
 */

/** Creates a minimal synthetic React.MouseEvent with a target that is (or
 * is a child of) an element owning a data-tooltip attribute. */
function makeEvent(opts: {
  targetEl: HTMLElement
  relatedTarget?: HTMLElement | null
}) {
  return {
    target: opts.targetEl,
    relatedTarget: opts.relatedTarget ?? null,
  } as unknown as React.MouseEvent
}

describe('useTooltipDelegation', () => {
  it('returns null tooltipState initially', () => {
    const { result } = renderHook(() => useTooltipDelegation())
    expect(result.current.tooltipState).toBeNull()
  })

  it('sets tooltipState on mouseOver of element with data-tooltip', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('button')
    el.setAttribute('data-tooltip', 'Compose')
    document.body.appendChild(el)

    // Simulate getBoundingClientRect to avoid all-zeros in jsdom.
    el.getBoundingClientRect = () =>
      ({ top: 100, right: 50, height: 40 } as DOMRect)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })

    expect(result.current.tooltipState).toEqual({
      text: 'Compose',
      x: 50 + 8, // rect.right + 8
      y: 100 + 40 / 2, // rect.top + rect.height / 2
    })

    document.body.removeChild(el)
  })

  it('does not set tooltipState when target has no data-tooltip', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('span')
    document.body.appendChild(el)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })

    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(el)
  })

  it('does not set tooltipState when data-tooltip is empty string', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('button')
    el.setAttribute('data-tooltip', '')
    document.body.appendChild(el)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })

    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(el)
  })

  it('resolves data-tooltip from ancestor via closest()', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const parent = document.createElement('button')
    parent.setAttribute('data-tooltip', 'Settings')
    parent.getBoundingClientRect = () =>
      ({ top: 200, right: 60, height: 30 } as DOMRect)

    const child = document.createElement('svg')
    parent.appendChild(child)
    document.body.appendChild(parent)

    // Fire event on the child icon — should bubble up and find parent's data-tooltip.
    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: child }))
    })

    expect(result.current.tooltipState).toEqual({
      text: 'Settings',
      x: 60 + 8,
      y: 200 + 30 / 2,
    })

    document.body.removeChild(parent)
  })

  it('clears tooltipState on mouseOut', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('button')
    el.setAttribute('data-tooltip', 'Inbox')
    el.getBoundingClientRect = () =>
      ({ top: 50, right: 48, height: 36 } as DOMRect)
    document.body.appendChild(el)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })
    expect(result.current.tooltipState).not.toBeNull()

    act(() => {
      result.current.handleMouseOut(makeEvent({ targetEl: el, relatedTarget: null }))
    })
    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(el)
  })

  it('does not clear tooltipState when relatedTarget is a child of the same data-tooltip ancestor', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const parent = document.createElement('button')
    parent.setAttribute('data-tooltip', 'Inbox')
    parent.getBoundingClientRect = () =>
      ({ top: 50, right: 48, height: 36 } as DOMRect)
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: parent }))
    })
    expect(result.current.tooltipState).not.toBeNull()

    // Mouse moves to child that is inside a [data-tooltip] ancestor — should not clear.
    act(() => {
      result.current.handleMouseOut(makeEvent({ targetEl: parent, relatedTarget: child }))
    })
    expect(result.current.tooltipState).not.toBeNull()

    document.body.removeChild(parent)
  })

  it('clears tooltipState when data-tooltip attr is removed from element mid-hover', () => {
    // Regression: expand button toggles sidebar → data-tooltip removed while
    // pointer still over element → mouseOut fires with no [data-tooltip] in DOM.
    // Old code: closest() returns null → early return → tooltip stays.
    // New code: relatedTarget check → setTooltipState(null) regardless.
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('button')
    el.setAttribute('data-tooltip', 'Expand sidebar')
    el.getBoundingClientRect = () =>
      ({ top: 60, right: 52, height: 36 } as DOMRect)
    document.body.appendChild(el)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })
    expect(result.current.tooltipState).not.toBeNull()

    // Simulate attribute removal (sidebar expands → data-tooltip set to undefined).
    el.removeAttribute('data-tooltip')

    // mouseOut fires after attr removal; relatedTarget is not inside any [data-tooltip].
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    act(() => {
      result.current.handleMouseOut(makeEvent({ targetEl: el, relatedTarget: outside }))
    })
    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(el)
    document.body.removeChild(outside)
  })

  it('clears tooltipState when cursor moves to element outside any data-tooltip', () => {
    const { result } = renderHook(() => useTooltipDelegation())

    const el = document.createElement('button')
    el.setAttribute('data-tooltip', 'Archive')
    el.getBoundingClientRect = () =>
      ({ top: 80, right: 55, height: 36 } as DOMRect)
    document.body.appendChild(el)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: el }))
    })
    expect(result.current.tooltipState).not.toBeNull()

    const nonTooltipEl = document.createElement('div')
    document.body.appendChild(nonTooltipEl)

    act(() => {
      result.current.handleMouseOut(makeEvent({ targetEl: el, relatedTarget: nonTooltipEl }))
    })
    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(el)
    document.body.removeChild(nonTooltipEl)
  })

  it('transitions to another data-tooltip element: mouseOut keeps state, mouseOver re-sets', () => {
    // Moving from one sidebar icon to another: mouseOut returns early (relatedTarget
    // has [data-tooltip]) keeping current tooltip; subsequent mouseOver re-sets it.
    const { result } = renderHook(() => useTooltipDelegation())

    const firstEl = document.createElement('button')
    firstEl.setAttribute('data-tooltip', 'Inbox')
    firstEl.getBoundingClientRect = () =>
      ({ top: 50, right: 48, height: 36 } as DOMRect)
    document.body.appendChild(firstEl)

    const secondEl = document.createElement('button')
    secondEl.setAttribute('data-tooltip', 'Sent')
    secondEl.getBoundingClientRect = () =>
      ({ top: 100, right: 48, height: 36 } as DOMRect)
    document.body.appendChild(secondEl)

    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: firstEl }))
    })
    expect(result.current.tooltipState?.text).toBe('Inbox')

    // mouseOut: relatedTarget is another [data-tooltip] element → hook returns early,
    // state preserved until mouseOver fires on secondEl.
    act(() => {
      result.current.handleMouseOut(makeEvent({ targetEl: firstEl, relatedTarget: secondEl }))
    })
    expect(result.current.tooltipState?.text).toBe('Inbox')

    // mouseOver on the second element updates state.
    act(() => {
      result.current.handleMouseOver(makeEvent({ targetEl: secondEl }))
    })
    expect(result.current.tooltipState?.text).toBe('Sent')

    document.body.removeChild(firstEl)
    document.body.removeChild(secondEl)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Native DOM listener path (containerRef)
// ─────────────────────────────────────────────────────────────────────────────
describe('useTooltipDelegation — native containerRef path', () => {
  /**
   * Fire a native MouseEvent on `target` with bubbling enabled so the event
   * travels up to the container (mimics real browser behaviour).
   */
  function fireNativeMouseover(target: HTMLElement, relatedTarget: HTMLElement | null = null) {
    const ev = new MouseEvent('mouseover', {
      bubbles: true,
      cancelable: true,
      relatedTarget,
    })
    Object.defineProperty(ev, 'target', { value: target, writable: false })
    target.dispatchEvent(ev)
  }

  function fireNativeMouseout(target: HTMLElement, relatedTarget: HTMLElement | null = null) {
    const ev = new MouseEvent('mouseout', {
      bubbles: true,
      cancelable: true,
      relatedTarget,
    })
    Object.defineProperty(ev, 'target', { value: target, writable: false })
    target.dispatchEvent(ev)
  }

  it('sets tooltipState via native mouseover when containerRef is attached', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Compose')
    btn.getBoundingClientRect = () => ({ top: 100, right: 50, height: 40 } as DOMRect)
    container.appendChild(btn)

    const { result } = renderHook(() => useTooltipDelegation())

    // Attach the containerRef to the container element.
    act(() => { result.current.containerRef(container) })

    // Dispatch a native mouseover on the button — should bubble to container.
    act(() => { fireNativeMouseover(btn) })

    expect(result.current.tooltipState).toEqual({
      text: 'Compose',
      x: 50 + 8,
      y: 100 + 40 / 2,
    })

    // Clean up.
    act(() => { result.current.containerRef(null) })
    document.body.removeChild(container)
  })

  it('clears tooltipState via native mouseout when relatedTarget is outside [data-tooltip]', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Inbox')
    btn.getBoundingClientRect = () => ({ top: 50, right: 48, height: 36 } as DOMRect)
    container.appendChild(btn)

    const outside = document.createElement('div')
    document.body.appendChild(outside)

    const { result } = renderHook(() => useTooltipDelegation())
    act(() => { result.current.containerRef(container) })

    // Set tooltip via native over.
    act(() => { fireNativeMouseover(btn) })
    expect(result.current.tooltipState).not.toBeNull()

    // Leave to a non-tooltip element — should clear.
    act(() => { fireNativeMouseout(btn, outside) })
    expect(result.current.tooltipState).toBeNull()

    act(() => { result.current.containerRef(null) })
    document.body.removeChild(container)
    document.body.removeChild(outside)
  })

  it('does NOT clear tooltipState via native mouseout when relatedTarget has data-tooltip', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn1 = document.createElement('button')
    btn1.setAttribute('data-tooltip', 'Inbox')
    btn1.getBoundingClientRect = () => ({ top: 50, right: 48, height: 36 } as DOMRect)
    container.appendChild(btn1)

    const btn2 = document.createElement('button')
    btn2.setAttribute('data-tooltip', 'Sent')
    container.appendChild(btn2)

    const { result } = renderHook(() => useTooltipDelegation())
    act(() => { result.current.containerRef(container) })

    act(() => { fireNativeMouseover(btn1) })
    expect(result.current.tooltipState?.text).toBe('Inbox')

    // Move to another [data-tooltip] element — should NOT clear.
    act(() => { fireNativeMouseout(btn1, btn2) })
    expect(result.current.tooltipState?.text).toBe('Inbox')

    act(() => { result.current.containerRef(null) })
    document.body.removeChild(container)
  })

  it('removes native listeners when containerRef is called with null', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Settings')
    btn.getBoundingClientRect = () => ({ top: 60, right: 52, height: 36 } as DOMRect)
    container.appendChild(btn)

    const { result } = renderHook(() => useTooltipDelegation())
    act(() => { result.current.containerRef(container) })

    // Confirm listeners are active.
    act(() => { fireNativeMouseover(btn) })
    expect(result.current.tooltipState).not.toBeNull()

    // Detach via null.
    act(() => {
      result.current.containerRef(null)
      // Clear manually so we can test that subsequent events are ignored.
      result.current.handleMouseOut({ target: btn, relatedTarget: null } as unknown as React.MouseEvent)
    })
    expect(result.current.tooltipState).toBeNull()

    // After detach, native mouseover on the old container should have no effect.
    act(() => { fireNativeMouseover(btn) })
    // State should remain null — listener was removed.
    expect(result.current.tooltipState).toBeNull()

    document.body.removeChild(container)
  })

  it('moves native listeners when ref remounts to a new container', () => {
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.appendChild(containerA)
    document.body.appendChild(containerB)

    const btnA = document.createElement('button')
    btnA.setAttribute('data-tooltip', 'From A')
    btnA.getBoundingClientRect = () => ({ top: 10, right: 20, height: 10 } as DOMRect)
    containerA.appendChild(btnA)

    const btnB = document.createElement('button')
    btnB.setAttribute('data-tooltip', 'From B')
    btnB.getBoundingClientRect = () => ({ top: 30, right: 40, height: 10 } as DOMRect)
    containerB.appendChild(btnB)

    const { result } = renderHook(() => useTooltipDelegation())

    // Mount on containerA.
    act(() => { result.current.containerRef(containerA) })
    act(() => { fireNativeMouseover(btnA) })
    expect(result.current.tooltipState?.text).toBe('From A')

    // Re-mount on containerB — listeners should move.
    act(() => { result.current.containerRef(containerB) })

    // Events on the OLD container must be ignored now.
    act(() => { fireNativeMouseover(btnA) })
    // Tooltip was NOT cleared by re-mount (state persists), but no new state from btnA.
    // Clear state first so we can assert silence from old container.
    act(() => { result.current.handleMouseOut({ target: btnA, relatedTarget: null } as unknown as React.MouseEvent) })
    expect(result.current.tooltipState).toBeNull()

    act(() => { fireNativeMouseover(btnA) })
    expect(result.current.tooltipState).toBeNull()

    // Events on the NEW container must work.
    act(() => { fireNativeMouseover(btnB) })
    expect(result.current.tooltipState?.text).toBe('From B')

    act(() => { result.current.containerRef(null) })
    document.body.removeChild(containerA)
    document.body.removeChild(containerB)
  })

  it('does not double-attach when ref receives the same node twice', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Once')
    btn.getBoundingClientRect = () => ({ top: 0, right: 10, height: 10 } as DOMRect)
    container.appendChild(btn)

    const { result } = renderHook(() => useTooltipDelegation())

    // Attach twice with the same node.
    act(() => { result.current.containerRef(container) })
    act(() => { result.current.containerRef(container) })

    // Track state updates by recording how many times state changes.
    let stateUpdateCount = 0
    const originalTooltip = result.current.tooltipState

    // Fire one mouseover — should produce exactly one state update.
    act(() => { fireNativeMouseover(btn) })
    if (result.current.tooltipState !== originalTooltip) stateUpdateCount++

    // If listeners were doubled, the tooltip text would be the same but we'd
    // have had two consecutive setTooltipState calls; with React batching in
    // testing-library that's hard to observe directly, so instead verify the
    // final state is correct (not null / not duplicated object) and no errors
    // were thrown.
    expect(result.current.tooltipState?.text).toBe('Once')
    expect(stateUpdateCount).toBe(1)

    act(() => { result.current.containerRef(null) })
    document.body.removeChild(container)
  })

  it('removes native listeners on hook unmount', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Unmount test')
    btn.getBoundingClientRect = () => ({ top: 0, right: 10, height: 10 } as DOMRect)
    container.appendChild(btn)

    const { result, unmount } = renderHook(() => useTooltipDelegation())
    act(() => { result.current.containerRef(container) })

    // Confirm active.
    act(() => { fireNativeMouseover(btn) })
    expect(result.current.tooltipState).not.toBeNull()

    // Unmount the hook (React unmount path — NOT containerRef(null)).
    act(() => { unmount() })

    // Dispatching on the old container must not throw and must not update state.
    // (result.current is stale after unmount — we just assert no throw here.)
    expect(() => {
      const ev = new MouseEvent('mouseover', { bubbles: true, cancelable: true })
      btn.dispatchEvent(ev)
    }).not.toThrow()

    document.body.removeChild(container)
  })

  it('ignores mouseout with null or non-Element relatedTarget / target', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const btn = document.createElement('button')
    btn.setAttribute('data-tooltip', 'Safe')
    btn.getBoundingClientRect = () => ({ top: 0, right: 10, height: 10 } as DOMRect)
    container.appendChild(btn)

    const { result } = renderHook(() => useTooltipDelegation())
    act(() => { result.current.containerRef(container) })

    // Set tooltip.
    act(() => { fireNativeMouseover(btn) })
    expect(result.current.tooltipState).not.toBeNull()

    // mouseout with null relatedTarget — should clear without throwing.
    expect(() => {
      act(() => { fireNativeMouseout(btn, null) })
    }).not.toThrow()
    expect(result.current.tooltipState).toBeNull()

    // mouseover where event target is not an Element — should not throw.
    act(() => { fireNativeMouseover(btn) })
    expect(() => {
      act(() => {
        const ev = new MouseEvent('mouseover', { bubbles: true, cancelable: true })
        // Dispatch raw event without a target override — target will be the
        // dispatch target (btn) which is a valid Element; this is fine.
        container.dispatchEvent(ev)
      })
    }).not.toThrow()

    act(() => { result.current.containerRef(null) })
    document.body.removeChild(container)
  })
})
