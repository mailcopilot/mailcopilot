/**
 * Pure option construction for the app's secondary (non-main) windows.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `electron/main.ts` is a hotspot (CLAUDE.md §5 "Hotspot policy"), and the
 * BrowserWindow option literal was duplicated between the generic child-window
 * factory (Settings / Account / Compose) and the standalone message window.
 * Keeping the option shape here — Electron-free, plain data in / plain data
 * out, mirroring the `windowGeometry.ts` precedent — makes the one decision
 * that actually carries product behaviour unit-testable: whether a window is
 * created as a window-manager CHILD of the main window or as a top-level one.
 *
 * THE `parent` DECISION (§3.3.B4.f6)
 * ----------------------------------
 * On Linux, Electron implements `parent` via the `WM_TRANSIENT_FOR` hint.
 * GNOME/Mutter treats a transient window as a dialog and clears its
 * `has_maximize_func` bit, so `BrowserWindow.maximize()` is silently ignored:
 * the custom titlebar's maximize button did nothing in the Compose window and
 * in the standalone message window, with no error anywhere in the
 * button → `win:maximize` IPC → handler chain (that chain is correct and was
 * left untouched).
 *
 * Both of those windows are long-lived document windows — the user works in
 * them, resizes them, wants them maximized side by side with the main window.
 * They are therefore created WITHOUT a parent. Settings and Account are short
 * dialog-class windows whose transient/on-top-of-main behaviour is desirable,
 * so they keep the parent.
 *
 * Dropping `parent` also drops Electron's automatic teardown of children when
 * the main window closes; `main.ts` restores that lifetime explicitly (see
 * the standalone-window registry there), so unparenting stays invisible in
 * the quit flow.
 */

import type { Rect, Size } from './windowGeometry'

export type ChildWindowKind = 'settings' | 'account' | 'compose' | 'mailWindow'

/**
 * Window kinds that must be top-level, never window-manager children.
 * See the module doc for the Mutter `has_maximize_func` rationale.
 */
const STANDALONE_KINDS: ReadonlySet<ChildWindowKind> = new Set<ChildWindowKind>([
  'compose',
  'mailWindow',
])

/** True when this window kind must be created without a WM parent. */
export function isStandaloneWindowKind(kind: ChildWindowKind): boolean {
  return STANDALONE_KINDS.has(kind)
}

export type ChildWindowOptionsInput<TParent> = {
  kind: ChildWindowKind
  width: number
  height: number
  /** Explicit placement; omitted when the platform default should apply. */
  x?: number
  y?: number
  title: string
  backgroundColor: string
  iconPath: string
  preloadPath: string
  additionalArguments: string[]
  /**
   * Platform-specific corner behaviour (`framelessCornerOptions()` in main.ts).
   * Passed in rather than computed so this module stays platform-agnostic.
   */
  cornerOptions?: { roundedCorners?: boolean }
  /**
   * The live main window. Used as WM parent for dialog-class kinds only;
   * ignored (never attached) for standalone kinds.
   */
  parent?: TParent | null
}

export type ChildWindowOptions<TParent> = {
  width: number
  height: number
  x?: number
  y?: number
  frame: false
  roundedCorners?: boolean
  show: false
  backgroundColor: string
  title: string
  icon: string
  parent?: TParent
  modal: false
  webPreferences: {
    preload: string
    nodeIntegration: false
    contextIsolation: true
    sandbox: true
    additionalArguments: string[]
  }
}

/**
 * Build the BrowserWindow constructor options for a secondary window.
 *
 * Security invariants (CLAUDE.md §5) are encoded here, not at the call sites:
 * `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and the
 * preload bridge are always present. `show: false` keeps the
 * `ready-to-show` no-white-flash contract; `frame: false` selects the custom
 * titlebar.
 */
export function buildChildWindowOptions<TParent>(
  input: ChildWindowOptionsInput<TParent>,
): ChildWindowOptions<TParent> {
  const standalone = isStandaloneWindowKind(input.kind)
  const parent = standalone ? null : (input.parent ?? null)
  return {
    width: input.width,
    height: input.height,
    ...(input.x != null ? { x: input.x } : {}),
    ...(input.y != null ? { y: input.y } : {}),
    frame: false,
    ...(input.cornerOptions ?? {}),
    show: false,
    backgroundColor: input.backgroundColor,
    title: input.title,
    icon: input.iconPath,
    ...(parent ? { parent } : {}),
    modal: false,
    webPreferences: {
      preload: input.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      additionalArguments: input.additionalArguments,
    },
  }
}

function clamp(value: number, lo: number, hi: number): number {
  // `hi < lo` happens when the window is larger than the work area; the low
  // bound wins so the window's top-left stays on screen.
  return Math.max(lo, Math.min(value, hi))
}

/** Diagonal step between successively opened standalone windows, in pixels. */
export const STANDALONE_CASCADE_STEP_PX = 24
/** Number of steps before the cascade returns to the centred position. */
export const STANDALONE_CASCADE_WRAP = 6

/**
 * Centre a new window over an anchor rectangle (the main window), clamped to
 * the anchor display's work area, optionally cascaded by `cascadeIndex`.
 *
 * Needed because the window manager used to do this for us: a transient
 * (parented) window is placed relative to its parent, while a top-level one
 * lands wherever the platform default puts it — on a multi-monitor setup that
 * can be a different display from the one the user is working on. This is
 * INITIAL PLACEMENT only, computed once at creation; it is not a bounds
 * correction and does not touch the window-rescue single-writer invariant
 * (docs/ARCHITECTURE.md "Window geometry").
 *
 * THE CASCADE (§3.3.B4.f6 fix wave)
 * ---------------------------------
 * This is the single placement policy for standalone windows: the message
 * window's former `offsetFromMainWindow()` (place to the right of main, else
 * inset) is gone — it picked its display by testing which work area contained
 * the main window's top-left corner and never clamped horizontally, so a main
 * window wider than the work area pushed the new window off screen.
 *
 * Pure centring alone would however stack every standalone window on exactly
 * the same pixel: message windows are deduplicated per message, not globally,
 * so opening three different messages must not look like nothing happened.
 * Hence a small diagonal offset by the number of standalone windows already
 * open, wrapping so a long-lived session cannot walk the placement into the
 * corner. The offset is applied BEFORE the clamp, so near the work area's
 * right/bottom edge the cascade collapses back onto the centred position
 * rather than pushing the window out of view — staying on screen wins.
 */
export function centerOverRect(
  anchor: Rect,
  workArea: Rect,
  size: Size,
  cascadeIndex = 0,
): { x: number; y: number } {
  // Defensive: a non-finite or negative index must degrade to plain centring,
  // never to NaN coordinates (BrowserWindow would ignore the whole placement).
  const steps = Number.isFinite(cascadeIndex) && cascadeIndex > 0
    ? Math.floor(cascadeIndex) % STANDALONE_CASCADE_WRAP
    : 0
  const cascade = steps * STANDALONE_CASCADE_STEP_PX
  const x = Math.round(anchor.x + (anchor.width - size.width) / 2) + cascade
  const y = Math.round(anchor.y + (anchor.height - size.height) / 2) + cascade
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - size.height),
  }
}
