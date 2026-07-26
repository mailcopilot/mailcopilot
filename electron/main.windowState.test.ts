/**
 * Window-rescue redesign — persisted window-state normalization.
 *
 * `loadWindowState` in `electron/main.ts` is a thin wrapper: fs read +
 * JSON.parse + delegation to the PRODUCTION `normalizeWindowState` from
 * `electron/windowGeometry.ts` (pure, Electron-free). These tests exercise
 * that production function directly — an earlier revision mirrored the
 * whole wrapper locally, which codex-bg-review flagged as a drift risk
 * (mirror and production can diverge while tests stay green). The only
 * behavior left untested in main.ts is the try/catch around fs/JSON.parse,
 * which maps any throw to null.
 *
 * The on-disk JSON is user-writable and survives upgrades, so the function
 * must reject NaN/Infinity (`1e400` parses to Infinity), non-numeric and
 * non-positive geometry, and must coerce `isMaximized` to a strict boolean.
 */
import { describe, expect, it } from 'vitest'
import { normalizeWindowState, type Rect } from './windowGeometry'

const MIN = { width: 900, height: 600 }
const FHD: Rect = { x: 0, y: 0, width: 1920, height: 1052 }

const norm = (raw: unknown, workAreas: Rect[] = [FHD]) => normalizeWindowState(raw, workAreas, MIN)

describe('normalizeWindowState — shape and validation failures', () => {
  it('returns null for non-object input (corrupted file parsed to a scalar)', () => {
    expect(norm('a string')).toBeNull()
    expect(norm(42)).toBeNull()
    expect(norm(null)).toBeNull()
    expect(norm(undefined)).toBeNull()
  })

  it('returns null when x is missing', () => {
    expect(norm({ y: 100, width: 1200, height: 800, isMaximized: false })).toBeNull()
  })

  it('returns null when y is missing', () => {
    expect(norm({ x: 100, width: 1200, height: 800, isMaximized: false })).toBeNull()
  })

  it('returns null when width is not a number', () => {
    expect(norm({ x: 100, y: 100, width: '1200', height: 800, isMaximized: false })).toBeNull()
  })

  it('returns null when height is missing', () => {
    expect(norm({ x: 100, y: 100, width: 1200, isMaximized: false })).toBeNull()
  })

  it('returns null for NaN coordinates', () => {
    expect(norm({ x: NaN, y: 100, width: 1200, height: 800, isMaximized: false })).toBeNull()
  })

  it('returns null for Infinity dimensions (JSON `1e400` overflows to Infinity)', () => {
    expect(norm(JSON.parse('{"x":100,"y":100,"width":1e400,"height":800,"isMaximized":false}'))).toBeNull()
    expect(norm({ x: -Infinity, y: 100, width: 1200, height: 800, isMaximized: false })).toBeNull()
  })

  it('returns null for zero or negative dimensions', () => {
    expect(norm({ x: 100, y: 100, width: 0, height: 800, isMaximized: false })).toBeNull()
    expect(norm({ x: 100, y: 100, width: 1200, height: -50, isMaximized: false })).toBeNull()
  })
})

describe('normalizeWindowState — valid state passthrough', () => {
  it('returns the saved geometry unchanged when sufficiently visible', () => {
    expect(norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: false }))
      .toEqual({ x: 100, y: 100, width: 1200, height: 800, isMaximized: false })
  })

  it('preserves isMaximized: true', () => {
    expect(norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: true })?.isMaximized).toBe(true)
  })

  it('coerces non-boolean isMaximized to false (a truthy string must not maximize)', () => {
    expect(norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: 'false' })?.isMaximized).toBe(false)
    expect(norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: 1 })?.isMaximized).toBe(false)
    expect(norm({ x: 100, y: 100, width: 1200, height: 800 })?.isMaximized).toBe(false)
  })

  it('strips unexpected extra fields from the persisted JSON', () => {
    const result = norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: false, extraField: 'dropped' })
    expect(result).toEqual({ x: 100, y: 100, width: 1200, height: 800, isMaximized: false })
    expect(result).not.toHaveProperty('extraField')
  })

  it('inflates a sub-minimum size to minSize (visibility is evaluated at the real window size)', () => {
    // BrowserWindow will inflate the request to minWidth/minHeight anyway;
    // normalizing early keeps the visibility math honest.
    expect(norm({ x: 100, y: 100, width: 500, height: 300, isMaximized: false }))
      .toEqual({ x: 100, y: 100, width: 900, height: 600, isMaximized: false })
  })

  it('rescues a crafted sub-minimum state that would materialize mostly off-screen after inflation', () => {
    // codex-security-review MEDIUM: {x:1821, width:99} is "fully visible" at
    // its declared size, but BrowserWindow inflates it to 900px wide and the
    // window would appear 89% past the right edge. Inflation-before-check
    // makes the rescue math see the real footprint and pull it back.
    expect(norm({ x: 1821, y: 100, width: 99, height: 600, isMaximized: false }))
      .toEqual({ x: 1020, y: 100, width: 900, height: 600, isMaximized: false })
  })
})

describe('normalizeWindowState — clamping onto the current display set', () => {
  it('clamps saved bounds referencing a removed display, preserving size', () => {
    // Window was last saved on a second monitor at x=2500; only the primary
    // (FHD) display remains at load time (undock while the app was closed).
    const result = norm({ x: 2500, y: 200, width: 1200, height: 800, isMaximized: false })
    expect(result).toEqual({ x: 720, y: 200, width: 1200, height: 800, isMaximized: false })
  })

  it('preserves isMaximized through the clamp path', () => {
    expect(norm({ x: 2500, y: 200, width: 1200, height: 800, isMaximized: true })?.isMaximized).toBe(true)
  })

  it('shrinks an oversized saved window to fit a smaller current display', () => {
    // Saved on a 1440p+ monitor (2560x1300); current display set is only FHD.
    const result = norm({ x: 0, y: 0, width: 2560, height: 1300, isMaximized: false })
    expect(result?.width).toBeLessThanOrEqual(FHD.width)
    expect(result?.height).toBeLessThanOrEqual(FHD.height)
  })

  it('respects minSize when the current work area is smaller than the window minimum', () => {
    // 200% scaling leaves a DIP work area below the 900x600 main-window
    // minimum: the normalized request must not go below minSize (Electron
    // would silently re-inflate it and desynchronize the math).
    const tiny: Rect = { x: 0, y: 0, width: 960, height: 510 }
    const result = norm({ x: 2000, y: 800, width: 1200, height: 800, isMaximized: false }, [tiny])
    expect(result).toEqual({ x: 0, y: 0, width: 960, height: 600, isMaximized: false })
  })

  it('returns null on an empty display list (no context to validate against)', () => {
    // With zero displays there is nothing to clamp to — trusting arbitrary
    // finite coordinates would let a crafted state place the window anywhere.
    // Falling back to the default BrowserWindow size/placement is safer.
    expect(norm({ x: 100, y: 100, width: 1200, height: 800, isMaximized: false }, [])).toBeNull()
  })
})
