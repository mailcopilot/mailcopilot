import { describe, it, expect } from 'vitest'
import {
  computeRescueTarget,
  isSufficientlyVisible,
  intersectRect,
  MAX_HIDDEN_FRACTION,
  type Rect,
} from './windowGeometry'

const FHD: Rect = { x: 0, y: 0, width: 1920, height: 1052 } // 1080p minus a 28px panel
const SECOND: Rect = { x: 1920, y: 0, width: 1920, height: 1052 }
const MIN = { width: 900, height: 600 }

describe('intersectRect', () => {
  it('returns the overlap rectangle', () => {
    expect(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }))
      .toEqual({ x: 50, y: 50, width: 50, height: 50 })
  })

  it('returns null for disjoint rectangles', () => {
    expect(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 0, width: 100, height: 100 }))
      .toBeNull()
  })

  it('returns null for edge-touching rectangles (zero area)', () => {
    expect(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 }))
      .toBeNull()
  })
})

describe('isSufficientlyVisible', () => {
  it('accepts a window fully inside a work area', () => {
    expect(isSufficientlyVisible({ x: 100, y: 100, width: 1200, height: 800 }, [FHD])).toBe(true)
  })

  it('accepts a small overhang past the right edge', () => {
    // 200px of 1200 hang off the right edge — user placement, leave alone.
    expect(isSufficientlyVisible({ x: 920, y: 100, width: 1200, height: 800 }, [FHD])).toBe(true)
  })

  it('rejects a window mostly past the right edge', () => {
    // Only 100px visible → hidden fraction > MAX_HIDDEN_FRACTION.
    expect(isSufficientlyVisible({ x: 1820, y: 100, width: 1200, height: 800 }, [FHD])).toBe(false)
  })

  it('rejects a window whose titlebar is above the work area', () => {
    // Body largely visible (hidden < threshold) but the grab strip is off-screen top.
    const bounds = { x: 100, y: -200, width: 1200, height: 800 }
    const hidden = 200 / 800
    expect(hidden).toBeLessThan(MAX_HIDDEN_FRACTION)
    expect(isSufficientlyVisible(bounds, [FHD])).toBe(false)
  })

  it('accepts a window hanging moderately past the bottom (titlebar grabbable, hidden < threshold)', () => {
    // 148px of 600 hang below the work area (~25% hidden).
    expect(isSufficientlyVisible({ x: 100, y: 600, width: 1200, height: 600 }, [FHD])).toBe(true)
  })

  it('rejects a window mostly below the work area even with a grabbable titlebar', () => {
    // Only 200px of 600 visible (~67% hidden) — effectively lost.
    expect(isSufficientlyVisible({ x: 100, y: 852, width: 1200, height: 600 }, [FHD])).toBe(false)
  })

  it('accepts a window spanning two monitors', () => {
    expect(isSufficientlyVisible({ x: 1000, y: 100, width: 2000, height: 800 }, [FHD, SECOND])).toBe(true)
  })

  it('does not double-count mirrored displays with identical work areas', () => {
    // Window half off the right edge of a mirrored pair: visible area must
    // not be summed twice into "fully visible".
    const bounds = { x: 1820, y: 100, width: 1200, height: 800 }
    expect(isSufficientlyVisible(bounds, [FHD, { ...FHD }])).toBe(false)
  })

  it('rejects when there are no work areas', () => {
    expect(isSufficientlyVisible({ x: 0, y: 0, width: 800, height: 600 }, [])).toBe(false)
  })

  it('rejects a zero-width bounds rect outright (guards against division by zero area)', () => {
    expect(isSufficientlyVisible({ x: 100, y: 100, width: 0, height: 600 }, [FHD])).toBe(false)
  })

  it('rejects a zero-height bounds rect outright (guards against division by zero area)', () => {
    expect(isSufficientlyVisible({ x: 100, y: 100, width: 800, height: 0 }, [FHD])).toBe(false)
  })

  it('accepts a window fully on a work area placed left of the primary (negative x)', () => {
    const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1052 }
    expect(isSufficientlyVisible({ x: -1800, y: 100, width: 1200, height: 800 }, [leftMonitor])).toBe(true)
  })

  it('accepts a window fully on a work area placed above the primary (negative y)', () => {
    const aboveMonitor: Rect = { x: 0, y: -1052, width: 1920, height: 1052 }
    expect(isSufficientlyVisible({ x: 100, y: -900, width: 1200, height: 800 }, [aboveMonitor])).toBe(true)
  })
})

describe('computeRescueTarget', () => {
  it('returns none with no displays (transient hotplug state)', () => {
    expect(computeRescueTarget({ bounds: { x: 0, y: 0, width: 800, height: 600 }, workAreas: [] }))
      .toEqual({ action: 'none' })
  })

  it('returns none for a visible window', () => {
    expect(computeRescueTarget({ bounds: { x: 100, y: 100, width: 1200, height: 800 }, workAreas: [FHD] }))
      .toEqual({ action: 'none' })
  })

  it('returns none for a deliberate small overhang', () => {
    expect(computeRescueTarget({ bounds: { x: 920, y: 100, width: 1200, height: 800 }, workAreas: [FHD] }))
      .toEqual({ action: 'none' })
  })

  it('pulls a window back from past the right edge, preserving size', () => {
    const d = computeRescueTarget({ bounds: { x: 1820, y: 100, width: 1200, height: 800 }, workAreas: [FHD] })
    expect(d).toEqual({ action: 'move', target: { x: 720, y: 100, width: 1200, height: 800 } })
  })

  it('pulls a window down when its titlebar is above the work area', () => {
    const d = computeRescueTarget({ bounds: { x: 100, y: -200, width: 1200, height: 800 }, workAreas: [FHD] })
    expect(d).toEqual({ action: 'move', target: { x: 100, y: 0, width: 1200, height: 800 } })
  })

  it('moves a window from a removed monitor onto the remaining one', () => {
    // Window lived on the second monitor; only the first remains.
    const d = computeRescueTarget({ bounds: { x: 2500, y: 200, width: 1200, height: 800 }, workAreas: [FHD] })
    expect(d).toEqual({ action: 'move', target: { x: 720, y: 200, width: 1200, height: 800 } })
  })

  it('picks the nearest display when nothing overlaps', () => {
    const d = computeRescueTarget({ bounds: { x: 4200, y: 200, width: 1200, height: 800 }, workAreas: [FHD, SECOND] })
    expect(d.action).toBe('move')
    if (d.action === 'move') {
      expect(d.target.x).toBe(SECOND.x + SECOND.width - 1200)
    }
  })

  it('shrinks an oversized window after a resolution downgrade', () => {
    // 2560x1300 window left over from a 1440p monitor, now on 1080p.
    const d = computeRescueTarget({
      bounds: { x: 0, y: 0, width: 2560, height: 1300 },
      workAreas: [FHD],
      minSize: MIN,
    })
    expect(d).toEqual({ action: 'move', target: { x: 0, y: 0, width: 1920, height: 1052 } })
  })

  it('never requests a size below minSize even when the work area is smaller', () => {
    // 200% scaling on 1080p → tiny DIP work area smaller than the main
    // window minimum. The request must stay at minSize (Electron would
    // silently re-inflate a smaller request) pinned to the work-area origin.
    const tiny: Rect = { x: 0, y: 0, width: 960, height: 510 }
    const d = computeRescueTarget({
      bounds: { x: 2000, y: 800, width: 1200, height: 800 },
      workAreas: [tiny],
      minSize: MIN,
    })
    expect(d).toEqual({ action: 'move', target: { x: 0, y: 0, width: 960, height: 600 } })
  })

  it('is idempotent when the work area is smaller than minSize (no thrash)', () => {
    // Window already pinned at the origin of a work area that cannot fit
    // it: >35% may stay hidden, but the achievable target equals current
    // bounds — must return none instead of re-issuing setBounds forever.
    const tiny: Rect = { x: 0, y: 0, width: 700, height: 400 }
    const d = computeRescueTarget({
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      workAreas: [tiny],
      minSize: MIN,
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('is idempotent: applying the target then recomputing yields none', () => {
    const first = computeRescueTarget({
      bounds: { x: 2500, y: 200, width: 1200, height: 800 },
      workAreas: [FHD],
      minSize: MIN,
    })
    expect(first.action).toBe('move')
    if (first.action === 'move') {
      const second = computeRescueTarget({ bounds: first.target, workAreas: [FHD], minSize: MIN })
      expect(second).toEqual({ action: 'none' })
    }
  })

  it('does not crash on a zero-width bounds and is a no-op without a minSize (nothing achievable to fix)', () => {
    // A degenerate saved state (corrupted persistence, race during resize)
    // must not crash the area/fraction math (division by rectArea(bounds)).
    // isSufficientlyVisible correctly rejects it, but with no minSize floor
    // the best achievable width is still min(0, best.width) = 0 — equal to
    // current bounds, so the idempotency guard returns 'none' rather than
    // thrashing on an unfixable window.
    const d = computeRescueTarget({
      bounds: { x: 100, y: 100, width: 0, height: 800 },
      workAreas: [FHD],
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('rescues a zero-width window up to minSize when a minSize is supplied', () => {
    // Realistic production case: both loadWindowState (main.ts) and
    // windowRescue always pass minSize (the BrowserWindow's actual minimum).
    // With a floor, the zero-width bounds IS fixable, so a move is issued.
    const d = computeRescueTarget({
      bounds: { x: 100, y: 100, width: 0, height: 800 },
      workAreas: [FHD],
      minSize: MIN,
    })
    expect(d.action).toBe('move')
    if (d.action === 'move') {
      expect(d.target.width).toBe(MIN.width)
    }
  })

  it('rescues a zero-height window up to minSize when a minSize is supplied', () => {
    const d = computeRescueTarget({
      bounds: { x: 100, y: 100, width: 1200, height: 0 },
      workAreas: [FHD],
      minSize: MIN,
    })
    expect(d.action).toBe('move')
    if (d.action === 'move') {
      expect(d.target.height).toBe(MIN.height)
    }
  })

  it('handles a monitor placed left of the primary (negative x) — window fully on it is visible', () => {
    // Common multi-monitor layout: secondary monitor to the left of primary,
    // so its work area has negative x coordinates.
    const leftMonitor: Rect = { x: -1920, y: 0, width: 1920, height: 1052 }
    const d = computeRescueTarget({
      bounds: { x: -1800, y: 100, width: 1200, height: 800 },
      workAreas: [leftMonitor, FHD],
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('rescues a window lost on a removed left-of-primary monitor onto the remaining primary', () => {
    // Window lived on the (now removed) negative-x monitor; only FHD (x=0) remains.
    const d = computeRescueTarget({
      bounds: { x: -1800, y: 100, width: 1200, height: 800 },
      workAreas: [FHD],
    })
    expect(d.action).toBe('move')
    if (d.action === 'move') {
      // Best display is FHD; window pinned within its work area (x >= 0).
      expect(d.target.x).toBeGreaterThanOrEqual(FHD.x)
      expect(d.target.x).toBeLessThanOrEqual(FHD.x + FHD.width - d.target.width)
    }
  })

  it('handles a monitor placed above the primary (negative y) — window fully on it is visible', () => {
    const aboveMonitor: Rect = { x: 0, y: -1052, width: 1920, height: 1052 }
    const d = computeRescueTarget({
      bounds: { x: 100, y: -900, width: 1200, height: 800 },
      workAreas: [aboveMonitor, FHD],
    })
    expect(d).toEqual({ action: 'none' })
  })

  it('rescues a window lost on a removed above-primary monitor onto the remaining primary', () => {
    // Window lived entirely above y=0 (removed monitor); only FHD remains.
    const d = computeRescueTarget({
      bounds: { x: 100, y: -900, width: 1200, height: 800 },
      workAreas: [FHD],
    })
    expect(d.action).toBe('move')
    if (d.action === 'move') {
      expect(d.target.y).toBeGreaterThanOrEqual(FHD.y)
      expect(d.target.y).toBeLessThanOrEqual(FHD.y + FHD.height - d.target.height)
    }
  })
})

describe('mirrored-display deduplication (codex-bg-review HIGH: double-count)', () => {
  it('rejects a half-visible window on identical mirrored displays', () => {
    // Exactly 50% of the window hangs off the shared right edge. Summing the
    // intersection per mirrored display would double 50% into a false 100%
    // visible; dedupeRects must count the mirror set once.
    const bounds = { x: 960, y: 0, width: 1920, height: 1052 }
    expect(isSufficientlyVisible(bounds, [FHD, { ...FHD }])).toBe(false)
    const d = computeRescueTarget({ bounds, workAreas: [FHD, { ...FHD }] })
    expect(d).toEqual({ action: 'move', target: { x: 0, y: 0, width: 1920, height: 1052 } })
  })

  it('still treats genuinely distinct displays as additive visibility', () => {
    // Same 50/50 split across two REAL side-by-side monitors is fine.
    const bounds = { x: 960, y: 0, width: 1920, height: 1052 }
    expect(isSufficientlyVisible(bounds, [FHD, SECOND])).toBe(true)
  })
})

describe('policy threshold boundaries', () => {
  it('accepts exactly MIN_VISIBLE_HEIGHT (24px) of the titlebar strip', () => {
    // y=-24 leaves exactly 24px of the 48px strip visible; body loses only
    // 24px so the hidden fraction stays tiny — the strip is the binding rule.
    expect(isSufficientlyVisible({ x: 100, y: -24, width: 1200, height: 800 }, [FHD])).toBe(true)
  })

  it('rejects one pixel below the titlebar height threshold', () => {
    expect(isSufficientlyVisible({ x: 100, y: -25, width: 1200, height: 800 }, [FHD])).toBe(false)
  })

  it('accepts exactly MIN_VISIBLE_WIDTH (100px) of the titlebar strip', () => {
    // 150-wide window with exactly 100px on-screen: width is the binding
    // rule (hidden fraction 1/3 stays under the 0.35 cap).
    expect(isSufficientlyVisible({ x: -50, y: 100, width: 150, height: 400 }, [FHD])).toBe(true)
  })

  it('rejects one pixel below the visible-width threshold', () => {
    expect(isSufficientlyVisible({ x: -51, y: 100, width: 150, height: 400 }, [FHD])).toBe(false)
  })

  it('accepts exactly MAX_HIDDEN_FRACTION (35%) hidden area', () => {
    // 1000-wide window with exactly 350px past the right edge.
    expect(isSufficientlyVisible({ x: 1270, y: 100, width: 1000, height: 800 }, [FHD])).toBe(true)
  })

  it('rejects just past the hidden-fraction threshold', () => {
    expect(isSufficientlyVisible({ x: 1271, y: 100, width: 1000, height: 800 }, [FHD])).toBe(false)
  })

  it('epsilon suppresses a 2px target delta but not a 3px one', () => {
    // Work area smaller than minSize: the achievable target is pinned at the
    // origin sized minSize. From (2,2) the delta is within BOUNDS_EPSILON →
    // none; from (3,3) it exceeds it → move.
    const tiny: Rect = { x: 0, y: 0, width: 700, height: 400 }
    expect(computeRescueTarget({ bounds: { x: 2, y: 2, width: 900, height: 600 }, workAreas: [tiny], minSize: MIN }))
      .toEqual({ action: 'none' })
    expect(computeRescueTarget({ bounds: { x: 3, y: 3, width: 900, height: 600 }, workAreas: [tiny], minSize: MIN }))
      .toEqual({ action: 'move', target: { x: 0, y: 0, width: 900, height: 600 } })
  })
})
