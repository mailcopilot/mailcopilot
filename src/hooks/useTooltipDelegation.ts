import { useCallback, useRef, useState, useEffect } from 'react'

export interface TooltipState {
  text: string
  x: number
  y: number
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the nearest `[data-tooltip]` ancestor of `target` and return the
 * tooltip text + position, or null if none found.
 * Accepts any `EventTarget` (native DOM or React synthetic).
 */
function resolveTooltipEnter(target: EventTarget | null): TooltipState | null {
  if (!(target instanceof Element)) return null
  const el = target.closest('[data-tooltip]')
  if (!(el instanceof HTMLElement)) return null
  const text = el.getAttribute('data-tooltip')
  if (!text) return null
  const rect = el.getBoundingClientRect()
  return { text, x: rect.right + 8, y: rect.top + rect.height / 2 }
}

/**
 * Returns true when the pointer is leaving to an element that is still inside
 * a `[data-tooltip]` ancestor — in that case the tooltip should NOT be cleared
 * (the subsequent `mouseover` will update it).
 */
function isLeavingToTooltipAncestor(relatedTarget: EventTarget | null): boolean {
  if (!(relatedTarget instanceof Element)) return false
  return relatedTarget.closest('[data-tooltip]') !== null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseTooltipDelegationOptions {
  /**
   * When true, the native mouseover/mouseout listeners will call
   * `e.stopPropagation()` before processing the event. Use this when the
   * container is nested inside another element that also uses
   * useTooltipDelegation — stopping propagation prevents the outer container
   * from activating a second tooltip portal for the same hover target.
   *
   * RecipientList sets this to `true` because `.mailcopilot-app` (App.tsx)
   * also runs a native delegation listener on the whole app root, which would
   * otherwise fire a duplicate `.tooltip-portal` whenever a chip is hovered.
   */
  stopNativePropagation?: boolean
}

/**
 * Event-delegation tooltip hook for the sidebar collapsed-mode tooltips.
 *
 * Attach the returned `containerRef` to a container element **or** use the
 * `handleMouseOver` / `handleMouseOut` props directly — both APIs are
 * supported for backwards compatibility.
 *
 * The primary attachment mechanism is the native DOM listener registered via
 * `containerRef` + `useEffect`. This avoids reliance on React's synthetic-event
 * delegation timing for hover detection. In the `tooltip-portal` e2e test and
 * during rapid sidebar expand/collapse, the native path proved more robust: the
 * `.tooltip-portal` element was not appearing reliably when only synthetic
 * `onMouseOver` was used. The underlying cause was not fully diagnosed; native
 * DOM listeners attached directly on the container ref are an established robust
 * fix for this class of hover-detection regression. The synthetic-event props
 * remain as a secondary fallback path.
 *
 * Any descendant with a `data-tooltip` attribute will trigger a tooltip
 * rendered via `.tooltip-portal` at `position: fixed`, which escapes the
 * `.mailcopilot-sidebar overflow: hidden` stacking context so tooltips are
 * never clipped when the sidebar is collapsed.
 *
 * @returns tooltipState — current tooltip to display (null = hidden)
 * @returns containerRef — attach to the container element (preferred)
 * @returns handleMouseOver — React synthetic fallback for `onMouseOver`
 * @returns handleMouseOut  — React synthetic fallback for `onMouseOut`
 */
export function useTooltipDelegation(options?: UseTooltipDelegationOptions): {
  tooltipState: TooltipState | null
  containerRef: React.RefCallback<HTMLElement>
  handleMouseOver: (e: React.MouseEvent) => void
  handleMouseOut: (e: React.MouseEvent) => void
} {
  const [tooltipState, setTooltipState] = useState<TooltipState | null>(null)

  // Keep a stable ref to the current setter so native listeners do not go stale.
  const setTooltipStateRef = useRef(setTooltipState)
  setTooltipStateRef.current = setTooltipState

  // ── Synthetic React event handlers (secondary / fallback path) ──────────────

  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const state = resolveTooltipEnter(e.target)
    if (state) setTooltipState(state)
  }, [])

  const handleMouseOut = useCallback((e: React.MouseEvent) => {
    if (isLeavingToTooltipAncestor(e.relatedTarget)) return
    setTooltipState(null)
  }, [])

  // ── Native DOM listener path (primary) ─────────────────────────────────────

  // Native listener refs — kept stable across re-renders.
  const nativeOverRef = useRef<((e: Event) => void) | null>(null)
  const nativeOutRef = useRef<((e: Event) => void) | null>(null)
  const containerNodeRef = useRef<HTMLElement | null>(null)

  const detachListeners = useCallback(() => {
    const node = containerNodeRef.current
    if (!node) return
    if (nativeOverRef.current) node.removeEventListener('mouseover', nativeOverRef.current)
    if (nativeOutRef.current) node.removeEventListener('mouseout', nativeOutRef.current)
    nativeOverRef.current = null
    nativeOutRef.current = null
  }, [])

  const stopNativePropagation = options?.stopNativePropagation ?? false

  const attachListeners = useCallback((node: HTMLElement) => {
    const over = (e: Event) => {
      if (stopNativePropagation) e.stopPropagation()
      const state = resolveTooltipEnter((e as MouseEvent).target)
      if (state) setTooltipStateRef.current(state)
    }
    const out = (e: Event) => {
      if (stopNativePropagation) e.stopPropagation()
      if (isLeavingToTooltipAncestor((e as MouseEvent).relatedTarget)) return
      setTooltipStateRef.current(null)
    }
    nativeOverRef.current = over
    nativeOutRef.current = out
    node.addEventListener('mouseover', over)
    node.addEventListener('mouseout', out)
  }, [stopNativePropagation])

  /**
   * RefCallback — called with the DOM node when the element mounts and with
   * null when it unmounts.  Moves native listeners from the old node to the
   * new one; calling with the same node twice is safe (detach + re-attach).
   */
  const containerRef = useCallback((node: HTMLElement | null) => {
    detachListeners()
    containerNodeRef.current = node
    if (node) {
      attachListeners(node)
    }
  }, [detachListeners, attachListeners])

  // Clean up native listeners on unmount.
  useEffect(() => {
    return () => {
      detachListeners()
    }
  }, [detachListeners])

  return { tooltipState, containerRef, handleMouseOver, handleMouseOut }
}
