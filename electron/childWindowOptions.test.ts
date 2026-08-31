import { describe, it, expect } from 'vitest'
import {
  buildChildWindowOptions,
  centerOverRect,
  isStandaloneWindowKind,
  STANDALONE_CASCADE_STEP_PX,
  STANDALONE_CASCADE_WRAP,
  type ChildWindowKind,
} from './childWindowOptions'

/**
 * §3.3.B4.f6 — the maximize button did nothing in the Compose window and in
 * the standalone message window on GNOME: Electron maps `parent` to
 * `WM_TRANSIENT_FOR`, Mutter treats a transient window as a dialog and clears
 * `has_maximize_func`, so `BrowserWindow.maximize()` is silently ignored.
 * These tests pin the fix — which kinds get a WM parent and which do not —
 * plus the security invariants the shared option builder now owns.
 */

const PARENT = { id: 'main-window' } as const
type FakeParent = typeof PARENT

function opts(kind: ChildWindowKind, extra: Partial<Parameters<typeof buildChildWindowOptions<FakeParent>>[0]> = {}) {
  return buildChildWindowOptions<FakeParent>({
    kind,
    width: 720,
    height: 560,
    title: 'T',
    backgroundColor: '#101010',
    iconPath: '/app/icon.png',
    preloadPath: '/app/preload.mjs',
    additionalArguments: ['--theme=dark'],
    parent: PARENT,
    ...extra,
  })
}

describe('isStandaloneWindowKind', () => {
  it('marks the long-lived document windows as standalone', () => {
    expect(isStandaloneWindowKind('compose')).toBe(true)
    expect(isStandaloneWindowKind('mailWindow')).toBe(true)
  })

  it('keeps the short dialog-class windows non-standalone', () => {
    expect(isStandaloneWindowKind('settings')).toBe(false)
    expect(isStandaloneWindowKind('account')).toBe(false)
  })
})

describe('buildChildWindowOptions — parent attachment', () => {
  it('attaches the main window as parent for settings / account', () => {
    expect(opts('settings').parent).toBe(PARENT)
    expect(opts('account').parent).toBe(PARENT)
  })

  it('omits parent entirely for compose / mailWindow', () => {
    for (const kind of ['compose', 'mailWindow'] as const) {
      const o = opts(kind)
      expect(o.parent).toBeUndefined()
      // Key must be absent, not merely undefined — makes the intent explicit
      // for anyone inspecting the constructed options.
      expect('parent' in o).toBe(false)
    }
  })

  it('ignores a supplied parent for standalone kinds even if one is passed', () => {
    // Regression guard: the caller passes `win` unconditionally; the decision
    // must live in this function, not at the call site.
    expect('parent' in opts('compose', { parent: PARENT })).toBe(false)
  })

  it('omits parent for dialog kinds when there is no live main window', () => {
    expect('parent' in opts('settings', { parent: null })).toBe(false)
    expect('parent' in opts('settings', { parent: undefined })).toBe(false)
  })

  it('never marks a window modal', () => {
    for (const kind of ['settings', 'account', 'compose', 'mailWindow'] as const) {
      expect(opts(kind).modal).toBe(false)
    }
  })
})

describe('buildChildWindowOptions — invariants shared by every kind', () => {
  it('keeps sandbox + contextIsolation + nodeIntegration:false + preload', () => {
    for (const kind of ['settings', 'account', 'compose', 'mailWindow'] as const) {
      const wp = opts(kind).webPreferences
      expect(wp.sandbox).toBe(true)
      expect(wp.contextIsolation).toBe(true)
      expect(wp.nodeIntegration).toBe(false)
      expect(wp.preload).toBe('/app/preload.mjs')
      expect(wp.additionalArguments).toEqual(['--theme=dark'])
    }
  })

  it('keeps show:false (ready-to-show, no white flash) and frame:false (custom titlebar)', () => {
    for (const kind of ['settings', 'account', 'compose', 'mailWindow'] as const) {
      expect(opts(kind).show).toBe(false)
      expect(opts(kind).frame).toBe(false)
    }
  })

  it('carries the theme background and title through for standalone kinds too', () => {
    const o = opts('compose')
    expect(o.backgroundColor).toBe('#101010')
    expect(o.title).toBe('T')
    expect(o.icon).toBe('/app/icon.png')
  })

  it('spreads platform corner options when supplied', () => {
    expect(opts('compose', { cornerOptions: { roundedCorners: false } }).roundedCorners).toBe(false)
    expect('roundedCorners' in opts('compose')).toBe(false)
  })
})

describe('buildChildWindowOptions — placement keys', () => {
  it('omits x / y when no placement is supplied (platform default)', () => {
    const o = opts('settings')
    expect('x' in o).toBe(false)
    expect('y' in o).toBe(false)
  })

  it('passes explicit placement through', () => {
    const o = opts('mailWindow', { x: 120, y: 40 })
    expect(o.x).toBe(120)
    expect(o.y).toBe(40)
  })

  it('keeps a zero coordinate (falsy but valid)', () => {
    const o = opts('mailWindow', { x: 0, y: 0 })
    expect(o.x).toBe(0)
    expect(o.y).toBe(0)
  })
})

describe('centerOverRect', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('centres the new window over the anchor', () => {
    const p = centerOverRect({ x: 200, y: 100, width: 1200, height: 800 }, workArea, { width: 720, height: 560 })
    expect(p).toEqual({ x: 200 + (1200 - 720) / 2, y: 100 + (800 - 560) / 2 })
  })

  it('clamps to the right / bottom edge of the work area', () => {
    const p = centerOverRect({ x: 1700, y: 900, width: 1200, height: 800 }, workArea, { width: 720, height: 560 })
    expect(p.x).toBe(1920 - 720)
    expect(p.y).toBe(1080 - 560)
  })

  it('clamps to the left / top edge of the work area', () => {
    const p = centerOverRect({ x: -400, y: -300, width: 600, height: 400 }, workArea, { width: 720, height: 560 })
    expect(p).toEqual({ x: 0, y: 0 })
  })

  it('honours a secondary display with a negative origin', () => {
    const secondary = { x: -1920, y: 0, width: 1920, height: 1080 }
    const p = centerOverRect({ x: -1800, y: 100, width: 1200, height: 800 }, secondary, { width: 720, height: 560 })
    expect(p.x).toBe(-1800 + (1200 - 720) / 2)
    expect(p.y).toBe(100 + (800 - 560) / 2)
  })

  it('pins the top-left inside the work area when the window is larger than it', () => {
    const small = { x: 10, y: 20, width: 640, height: 480 }
    const p = centerOverRect({ x: 10, y: 20, width: 640, height: 480 }, small, { width: 800, height: 900 })
    expect(p).toEqual({ x: 10, y: 20 })
  })

  it('returns integral coordinates', () => {
    const p = centerOverRect({ x: 0, y: 0, width: 1201, height: 801 }, workArea, { width: 720, height: 560 })
    expect(Number.isInteger(p.x)).toBe(true)
    expect(Number.isInteger(p.y)).toBe(true)
  })

  it('centres a zero-size window on the anchor midpoint instead of dividing by zero or throwing', () => {
    const p = centerOverRect({ x: 100, y: 200, width: 1200, height: 800 }, workArea, { width: 0, height: 0 })
    expect(p).toEqual({ x: 100 + 1200 / 2, y: 200 + 800 / 2 })
  })

  it('ignores the cascade for the first window (index 0)', () => {
    const anchor = { x: 200, y: 100, width: 1200, height: 800 }
    const size = { width: 720, height: 560 }
    expect(centerOverRect(anchor, workArea, size, 0)).toEqual(centerOverRect(anchor, workArea, size))
  })

  it('offsets successive windows diagonally by one step each', () => {
    const anchor = { x: 200, y: 100, width: 1200, height: 800 }
    const size = { width: 720, height: 560 }
    const base = centerOverRect(anchor, workArea, size)
    for (const index of [1, 2, 3]) {
      const p = centerOverRect(anchor, workArea, size, index)
      expect(p.x).toBe(base.x + index * STANDALONE_CASCADE_STEP_PX)
      expect(p.y).toBe(base.y + index * STANDALONE_CASCADE_STEP_PX)
    }
  })

  it('wraps back to the centred position so a long session cannot walk into the corner', () => {
    const anchor = { x: 200, y: 100, width: 1200, height: 800 }
    const size = { width: 720, height: 560 }
    const base = centerOverRect(anchor, workArea, size)
    expect(centerOverRect(anchor, workArea, size, STANDALONE_CASCADE_WRAP)).toEqual(base)
    expect(centerOverRect(anchor, workArea, size, STANDALONE_CASCADE_WRAP + 1))
      .toEqual(centerOverRect(anchor, workArea, size, 1))
  })

  it('lets the clamp win over the cascade at the work area edge', () => {
    // Staying on screen beats visual separation: a cascade that pushed the
    // window past the edge would hide its titlebar and hand the problem to
    // windowRescue.
    const anchor = { x: 1700, y: 900, width: 1200, height: 800 }
    const p = centerOverRect(anchor, workArea, { width: 720, height: 560 }, 3)
    expect(p.x).toBe(1920 - 720)
    expect(p.y).toBe(1080 - 560)
  })

  it('degrades a nonsensical cascade index to plain centring instead of NaN', () => {
    const anchor = { x: 200, y: 100, width: 1200, height: 800 }
    const size = { width: 720, height: 560 }
    const base = centerOverRect(anchor, workArea, size)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(centerOverRect(anchor, workArea, size, bad)).toEqual(base)
    }
  })

  it('keeps cascaded coordinates integral', () => {
    const p = centerOverRect({ x: 0, y: 0, width: 1201, height: 801 }, workArea, { width: 720, height: 560 }, 2)
    expect(Number.isInteger(p.x)).toBe(true)
    expect(Number.isInteger(p.y)).toBe(true)
  })

  it('does not throw when the work area itself has zero size', () => {
    // Defensive: a display report with a zero-size work area (e.g. transient
    // multi-monitor reconfiguration mid-call) must still yield a number pair,
    // not NaN from a `hi < lo` clamp collapsing incorrectly.
    const emptyWorkArea = { x: 500, y: 500, width: 0, height: 0 }
    const p = centerOverRect({ x: 500, y: 500, width: 1200, height: 800 }, emptyWorkArea, { width: 720, height: 560 })
    expect(Number.isNaN(p.x)).toBe(false)
    expect(Number.isNaN(p.y)).toBe(false)
    expect(p).toEqual({ x: 500, y: 500 })
  })
})

/**
 * Lifetime contract mirrored from `main.ts` (`standaloneChildWindows` +
 * `closeStandaloneChildWindows`, called from the main window's `closed`
 * handler). Mirrored rather than imported for the reason documented at the
 * top of `main.openInWindow.test.ts`: `main.ts` cannot be pulled into a
 * vitest run. Unparenting removed Electron's automatic teardown of children,
 * so this registry is what keeps closing the main window from leaving
 * orphaned windows that block `window-all-closed` (and therefore quit).
 */
describe('standalone window lifetime contract', () => {
  type FakeWin = { destroyed: boolean; closes: number; onClosed: () => void }

  function makeRegistry() {
    const set = new Set<FakeWin>()
    return {
      set,
      register(w: FakeWin) {
        set.add(w)
        w.onClosed = () => { set.delete(w) }
      },
      closeAll() {
        for (const w of [...set]) {
          if (!w.destroyed) { w.closes++; w.destroyed = true; w.onClosed() }
        }
      },
    }
  }

  const makeWin = (): FakeWin => ({ destroyed: false, closes: 0, onClosed: () => {} })

  it('closes every registered standalone window when the main window closes', () => {
    const reg = makeRegistry()
    const compose = makeWin()
    const mail = makeWin()
    reg.register(compose)
    reg.register(mail)

    reg.closeAll()

    expect(compose.closes).toBe(1)
    expect(mail.closes).toBe(1)
    expect(reg.set.size).toBe(0)
  })

  it('drops a window from the registry when the user closes it first', () => {
    const reg = makeRegistry()
    const compose = makeWin()
    reg.register(compose)

    compose.destroyed = true
    compose.onClosed()
    expect(reg.set.size).toBe(0)

    reg.closeAll()
    expect(compose.closes).toBe(0)
  })

  it('is idempotent — a second sweep closes nothing', () => {
    const reg = makeRegistry()
    const compose = makeWin()
    reg.register(compose)

    reg.closeAll()
    reg.closeAll()

    expect(compose.closes).toBe(1)
  })
})
