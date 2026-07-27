/**
 * Pure geometry math for the window-rescue subsystem.
 *
 * Design contract (see docs/ARCHITECTURE.md "Window geometry — single writer"):
 * the main process is the ONLY writer of window bounds corrections, and it
 * follows a "rescue, not police" policy — a window is repositioned only when
 * it is effectively lost to the user, never merely because it overlaps a
 * work-area edge. This makes the correction idempotent by construction:
 * after one rescue the window is visible, so every subsequent evaluation is
 * a no-op and renderer/WM/main feedback loops cannot oscillate.
 *
 * This module is deliberately Electron-free (plain rectangles in/out) so the
 * decision logic is unit-testable without mocking the runtime.
 */

export type Rect = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }

export type RescueDecision =
  | { action: 'none' }
  | { action: 'move'; target: Rect }

/**
 * Height of the strip at the top of a window that must stay reachable.
 * Matches the custom titlebar height class in the renderer (~40px) with a
 * small margin; if this strip is visible the user can drag the window back
 * without our help.
 */
export const TITLEBAR_STRIP_HEIGHT = 48

/** Minimum visible chunk of the titlebar strip that counts as "grabbable". */
export const MIN_VISIBLE_WIDTH = 100
export const MIN_VISIBLE_HEIGHT = 24

/**
 * A window may legitimately overhang work-area edges (user placement,
 * spanning two monitors). Only when more than this fraction of its area is
 * on no display at all do we consider it lost. 0.35 tolerates the
 * work-area-smaller-than-min-size case (~15% hidden) without thrashing.
 */
export const MAX_HIDDEN_FRACTION = 0.35

/**
 * Tolerance when comparing a computed target against current bounds.
 * Fractional display scaling rounds window geometry by ±1px between what we
 * request and what the WM reports back; treating those as equal prevents
 * endless 1px correction passes.
 */
export const BOUNDS_EPSILON = 2

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Mirrored displays report identical work areas; summing per-display
 * intersections would double-count them and report a half-hidden window as
 * fully visible. Deduplicate exact-equal rects before area math. Partially
 * overlapping (non-identical) work areas are not unioned — real desktops
 * tile displays, and the only overlap that occurs in practice is the exact
 * mirror case handled here.
 */
function dedupeRects(rects: Rect[]): Rect[] {
  const seen = new Set<string>()
  return rects.filter((r) => {
    const key = `${r.x}:${r.y}:${r.width}:${r.height}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function rectArea(r: Rect): number {
  return r.width * r.height
}

function centerDistanceSq(a: Rect, b: Rect): number {
  const dx = (a.x + a.width / 2) - (b.x + b.width / 2)
  const dy = (a.y + a.height / 2) - (b.y + b.height / 2)
  return dx * dx + dy * dy
}

/**
 * A window is "sufficiently visible" when (a) enough of its titlebar strip
 * lands on some work area for the user to grab it, and (b) at most
 * MAX_HIDDEN_FRACTION of its total area is off every work area.
 */
export function isSufficientlyVisible(bounds: Rect, workAreas: Rect[]): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  const areas = dedupeRects(workAreas)
  const strip: Rect = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.min(TITLEBAR_STRIP_HEIGHT, bounds.height),
  }
  const needW = Math.min(MIN_VISIBLE_WIDTH, bounds.width)
  const needH = Math.min(MIN_VISIBLE_HEIGHT, strip.height)
  const grabbable = areas.some((wa) => {
    const i = intersectRect(strip, wa)
    return i !== null && i.width >= needW && i.height >= needH
  })
  if (!grabbable) return false

  // The clamp is a second line of defense for exotic partial overlaps; the
  // mirrored (identical) case is already removed by dedupeRects above.
  const visibleSum = areas.reduce((sum, wa) => {
    const i = intersectRect(bounds, wa)
    return sum + (i ? rectArea(i) : 0)
  }, 0)
  const visible = Math.min(visibleSum, rectArea(bounds))
  const hiddenFraction = 1 - visible / rectArea(bounds)
  return hiddenFraction <= MAX_HIDDEN_FRACTION
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

function boundsApproxEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= BOUNDS_EPSILON &&
    Math.abs(a.y - b.y) <= BOUNDS_EPSILON &&
    Math.abs(a.width - b.width) <= BOUNDS_EPSILON &&
    Math.abs(a.height - b.height) <= BOUNDS_EPSILON
  )
}

/**
 * Decide whether (and where) a window must be moved to stay usable.
 *
 * Returns { action: 'none' } when:
 *  - there are no displays (transient hotplug state — nothing sane to do);
 *  - the window is sufficiently visible (see isSufficientlyVisible);
 *  - the best achievable target equals current bounds within BOUNDS_EPSILON
 *    (e.g. work area smaller than the window's minimum size and the window
 *    is already pinned — retrying would only thrash).
 *
 * Otherwise returns a target clamped into the best display's work area:
 *  - size shrinks to the work area but never below minSize (Electron would
 *    silently re-inflate a sub-minimum request, desynchronizing the math);
 *  - when the window cannot fit, it is pinned to the work-area origin so the
 *    titlebar stays reachable;
 *  - position is otherwise preserved as closely as possible.
 */
export function computeRescueTarget(opts: {
  bounds: Rect
  workAreas: Rect[]
  minSize?: Size
}): RescueDecision {
  const { bounds, workAreas, minSize } = opts
  if (workAreas.length === 0) return { action: 'none' }
  if (isSufficientlyVisible(bounds, workAreas)) return { action: 'none' }

  // Best display: largest overlap with the window; when nothing overlaps,
  // the nearest by center distance (handles "monitor above/below" layouts
  // better than defaulting to the primary).
  let best = workAreas[0]
  let bestArea = -1
  let bestDist = Number.POSITIVE_INFINITY
  for (const wa of workAreas) {
    const i = intersectRect(bounds, wa)
    const area = i ? rectArea(i) : 0
    const dist = centerDistanceSq(bounds, wa)
    if (area > bestArea || (area === bestArea && dist < bestDist)) {
      best = wa
      bestArea = area
      bestDist = dist
    }
  }

  let width = Math.min(bounds.width, best.width)
  let height = Math.min(bounds.height, best.height)
  if (minSize) {
    width = Math.max(width, minSize.width)
    height = Math.max(height, minSize.height)
  }
  const x = width >= best.width ? best.x : clamp(bounds.x, best.x, best.x + best.width - width)
  const y = height >= best.height ? best.y : clamp(bounds.y, best.y, best.y + best.height - height)

  const target: Rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  if (boundsApproxEqual(target, bounds)) return { action: 'none' }
  return { action: 'move', target }
}

export type PersistedWindowState = Rect & { isMaximized: boolean }

/**
 * Validate and normalize a window state deserialized from disk.
 *
 * The JSON file is user-writable and survives app upgrades, so nothing about
 * its shape can be trusted: values may be missing, non-numeric, NaN/Infinity
 * (`1e400` parses to Infinity), non-positive, or reference displays that no
 * longer exist. Returns null when the geometry is unusable; otherwise returns
 * the state clamped onto the current display set via computeRescueTarget
 * (preserving the saved size where possible). `isMaximized` is coerced to a
 * strict boolean (a truthy string must not maximize the window).
 *
 * Sub-minimum sizes are inflated to minSize BEFORE the visibility check:
 * BrowserWindow enforces minWidth/minHeight at construction anyway, so
 * visibility must be evaluated at the size the window will actually have —
 * a crafted 99px-wide state at the screen edge would otherwise pass the
 * check and then materialize mostly off-screen (codex-security-review
 * MEDIUM). An empty display list yields null rather than trusting arbitrary
 * coordinates with no display context to validate against.
 */
export function normalizeWindowState(
  raw: unknown,
  workAreas: Rect[],
  minSize: Size,
): PersistedWindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  if (workAreas.length === 0) return null
  const r = raw as Record<string, unknown>
  const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.width) || !isFiniteNumber(r.height)) {
    return null
  }
  if (r.width <= 0 || r.height <= 0) return null
  let bounds: Rect = {
    x: r.x,
    y: r.y,
    width: Math.max(r.width, minSize.width),
    height: Math.max(r.height, minSize.height),
  }
  const decision = computeRescueTarget({ bounds, workAreas, minSize })
  if (decision.action === 'move') bounds = decision.target
  return { ...bounds, isMaximized: r.isMaximized === true }
}
