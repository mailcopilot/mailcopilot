/**
 * §2.99 — the tray icon and the unread surfaces that hang off it.
 *
 * This service owns the whole OS-facing side: creating and destroying the
 * `Tray`, rebuilding its menu when the language changes, the tooltip, the
 * macOS/Unity dock badge and the Windows taskbar overlay. main.ts only wires
 * callbacks into it (hotspot policy) and all the arithmetic lives in the pure
 * electron/unreadBadge.ts, which has no electron import and is tested without
 * a display server.
 *
 * Two invariants worth stating because other code depends on them:
 *  - `isTrayActive()` is a statement about OUR OBJECT, not about the desktop:
 *    on Linux `new Tray()` succeeds even when no StatusNotifier host takes the
 *    registration (§2.228). Close-to-tray is gated on it anyway, deliberately —
 *    the desktop-side confirmation §2.228 added was removed again, because a
 *    hidden window is reachable whatever the icon is doing: relaunching from the
 *    launcher on Linux/Windows (`second-instance`) and clicking the dock icon on
 *    macOS (`activate`) both route through `showMainWindow()` in main.ts, which
 *    shows and focuses it (see backgroundMail.ts and docs/ARCHITECTURE.md
 *    «Закрытие в трей»).
 *  - Nothing here touches window geometry. windowRescue remains the single
 *    writer of bounds (CLAUDE.md §5).
 */

import { app, Menu, Tray, nativeImage, BrowserWindow, type NativeImage } from 'electron'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { trayLabels, TRAY_LABELS } from '../trayLabels'
import {
  formatTrayTooltip,
  formatBadgeText,
  renderBadgeDotBitmap,
  OVERLAY_ICON_SIZE,
} from '../unreadBadge'

const log = createLogger('Tray')

/** Debounce for unread recomputation — mail arrives in batches, not per row. */
export const UNREAD_REFRESH_DEBOUNCE_MS = 750

export interface TrayServiceDeps {
  /** Absolute path of the tray icon image. */
  iconPath: string
  /** Show / create the main window (tray click, "Open"). */
  onOpen: () => void
  /** Open a Compose window through the existing renderer-independent path. */
  onCompose: () => void
  /** Trigger the existing periodic-sync entry point. */
  onCheckMail: () => void
  /** Quit the whole app (app.quit, never app.exit — the drain must run). */
  onQuit: () => void
  /**
   * Total unread across all accounts under the SHARED badge policy
   * (packages/core `sumBadgeUnread`, fed from packages/db by
   * services/backgroundMail.ts). The number arrives already decided so that
   * exactly one place in the product answers "does this folder count"
   * (review H2).
   */
  countUnreadTotal: () => number
  /** The main window, for the Windows taskbar overlay. Null when closed. */
  getMainWindow: () => BrowserWindow | null
  getSettings: () => { language?: string; trayEnabled?: boolean }
}

let tray: Tray | null = null
let deps: TrayServiceDeps | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastTotal = 0
/**
 * Set by `disarmTray()` only — the quit gate (review L1).
 *
 * A sync pass still draining while `before-quit` runs would otherwise re-arm
 * the debounce and fire a refresh into a half-torn-down app, and a menu click
 * arriving during the drain would run Open / Compose / Check Mail against
 * services that are already stopping (`runMenuAction`). Deliberately NOT
 * set by `destroyTray()`: turning the tray icon off is not shutting the app
 * down, and the dock/taskbar badge keeps working without an icon.
 */
let disposed = false

/** Do we hold a live tray icon right now? Half of the close-to-tray gate. */
export function isTrayActive(): boolean {
  return tray !== null && !tray.isDestroyed()
}

/** Wire the service. Does not create the icon — call `applyTraySetting`. */
export function initTray(next: TrayServiceDeps): void {
  deps = next
  disposed = false
}

/**
 * Load the tray image, or throw (review M6).
 *
 * An empty NativeImage still constructs a Tray on most platforms — an
 * invisible icon that nonetheless makes `isTrayActive()` true, i.e. close-to-
 * tray hiding the window behind something the user cannot click. Refusing the
 * empty image keeps the "the icon EXISTS" gate meaningful.
 */
function trayIconImage(iconPath: string): NativeImage {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error('tray icon image is empty')
  // Tray icons are small; hand the OS a scaled copy rather than a 512px PNG.
  const size = process.platform === 'darwin' ? 16 : 22
  const resized = image.resize({ width: size, height: size })
  if (resized.isEmpty()) throw new Error('tray icon image resize produced an empty image')
  return resized
}

function buildMenu(): Electron.Menu {
  const d = deps
  const labels = trayLabels(d?.getSettings().language)
  return Menu.buildFromTemplate([
    { label: labels.open, click: () => runMenuAction('open', () => d?.onOpen()) },
    { label: labels.compose, click: () => runMenuAction('compose', () => d?.onCompose()) },
    { label: labels.checkMail, click: () => runMenuAction('check_mail', () => d?.onCheckMail()) },
    { type: 'separator' },
    { label: labels.quit, click: () => runMenuAction('quit', () => d?.onQuit()) },
  ])
}

function runMenuAction(action: 'open' | 'compose' | 'check_mail' | 'quit', fn: () => void): void {
  // The quit gate lives HERE, at the point where the action is actually taken.
  //
  // `disarmTray()` also paints a single inert line over the menu, but that is a
  // PICTURE of this state and a picture can fail to render: if
  // `Menu.buildFromTemplate` or `setContextMenu` throws — a tray host that went
  // away mid-drain — the previous LIVE menu stays installed and every entry
  // stays clickable for the whole drain. Check Mail would then start fresh IMAP
  // work against a pool that is logging out, and Open / Compose would act on
  // half-stopped state. Guarding the action instead of only the paint makes the
  // refusal hold whether or not the repaint succeeded.
  //
  // Quit is refused on the same terms: the drain is already running and is not
  // cancellable, so a second Quit only re-enters `before-quit`, whose re-entry
  // guard defers it again.
  //
  // Deliberately NOT counted as `tray.menu_action`. That event answers "which
  // entries does the user actually invoke, i.e. which earn their place"
  // (metricsSchema purpose), and a refused click invoked nothing — counting it
  // would inflate the very number the decision is made on. A refusal is a rare
  // race during shutdown; the log line is the right place for it, and no
  // user-facing string is involved (adding one would mean six locales).
  if (disposed) {
    log.info('Tray action refused — the app is quitting', { action })
    return
  }
  try {
    recordEvent('tray.menu_action', { action })
  } catch { /* telemetry never breaks a click */ }
  try {
    fn()
  } catch (err) {
    log.error(`Tray action "${action}" failed:`, err)
    captureException(err, { source: 'tray:menuAction', action })
  }
}

/**
 * Create the icon if the setting asks for it and it does not exist yet, or
 * destroy it if the setting was turned off. Safe to call repeatedly; called
 * once at startup and again from the settings-changed reaction.
 */
export function applyTraySetting(enabled: boolean): void {
  const d = deps
  if (!d) return
  // The icon now outlives the start of the quit drain, and the renderer is
  // still alive for those seconds: a settings toggle arriving mid-drain must
  // not mint a fresh Tray after the final destroy, nor paint the unread menu
  // back over the "quitting" one.
  if (disposed) return
  if (!enabled) {
    destroyTray()
    return
  }
  if (isTrayActive()) {
    // Already there — refresh the menu (the language may have changed).
    try { tray?.setContextMenu(buildMenu()) } catch { /* ignore */ }
    return
  }
  // Built locally and published to the module only once fully initialised, so a
  // throw half-way through cannot leave a live-but-unreachable Tray behind
  // (review M6): the local handle is what the catch destroys.
  let created: Tray | null = null
  try {
    const image = trayIconImage(d.iconPath)
    created = new Tray(image)
    created.setContextMenu(buildMenu())
    created.setToolTip(app.getName())
    // Left click on Windows/Linux is the "bring the app back" gesture; macOS
    // opens the menu itself, so `click` there is a no-op we do not register.
    if (process.platform !== 'darwin') {
      created.on('click', () => runMenuAction('open', () => d.onOpen()))
    }
    tray = created
    recordEvent('tray.created', { outcome: 'created', platform: process.platform as 'linux' | 'darwin' | 'win32' })
    log.info('Tray icon created')
    refreshUnreadNow()
  } catch (err) {
    // What lands here is a LOCAL failure — an unreadable or empty icon file, a
    // platform refusing to construct the object at all. A missing tray host
    // does NOT: §2.228 disproved that hypothesis on a live GNOME session where
    // construction succeeded and the icon was never taken. Whether anything
    // draws the icon is a question we no longer ask (§2.228, gate removed).
    // Normal environment, not a bug in this build: log it, report it once, and
    // leave `tray` null. Anything the OS did give us is handed back here.
    if (created) {
      try { if (!created.isDestroyed()) created.destroy() } catch { /* already gone */ }
    }
    tray = null
    log.warn('Tray icon could not be created:', err)
    try {
      recordEvent('tray.created', { outcome: 'failed', platform: process.platform as 'linux' | 'darwin' | 'win32' })
    } catch { /* telemetry never throws */ }
    captureException(err, { source: 'tray:create' })
  }
}

/**
 * Tear the icon down (the user turned the tray off, or shutdown). Idempotent.
 *
 * The pending unread recount is deliberately LEFT RUNNING (review round 2,
 * MEDIUM-2): the dock/taskbar badge outlives the icon, so cancelling the timer
 * here discarded the recount of a mutation that had just happened and left the
 * badge stale until the next one. Only `disarmTray` — the quit path — drops
 * pending work.
 */
export function destroyTray(): void {
  if (!tray) return
  try {
    if (!tray.isDestroyed()) tray.destroy()
  } catch (err) {
    log.warn('Tray destroy failed:', err)
  }
  tray = null
}

/**
 * Quit-time DISARM — the half of the old `shutdownTray()` that has to happen
 * early, split out from the half that must happen late.
 *
 * Keeps review L1's guarantee intact: `disposed` plus dropping the pending
 * recount is what stops a sync pass still draining during `before-quit` from
 * re-arming the debounce and repainting a half-torn-down app. The same
 * `disposed` flag is what makes `runMenuAction` refuse clicks from here on —
 * that refusal, not the inert menu drawn below, is the guarantee. What it no
 * longer does is destroy the icon — that used to go with it, and the icon
 * vanished the instant the user picked Quit while the window stayed on screen
 * for the whole drain (bounded at ~28s by main.ts's per-step teardown
 * deadlines), i.e. the icon lied in the one moment its meaning ("the app is
 * running") mattered. It stays, saying `quitting`, until `shutdownTray()` at
 * the end of the drain.
 *
 * Idempotent, and safe with no icon. `initTray` re-opens the service.
 */
export function disarmTray(): void {
  disposed = true
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  showQuittingState()
}

/**
 * Say the app is on its way out. Best effort by construction: a tooltip is an
 * explanation, never a guarantee, and nothing here may throw into a quit.
 */
function showQuittingState(): void {
  if (!isTrayActive()) return
  // Three independent guards, in this order, because they are not equally
  // important. Installing the inert menu is the closest thing here to a
  // functional act — it removes Open / Compose / Check Mail / Quit from the
  // menu while the drain runs — but it is still only a PICTURE of the quitting
  // state, and `setContextMenu` can throw and leave the live menu on screen.
  // What actually refuses those actions is the `disposed` check in
  // `runMenuAction`, which holds whether or not this repaint lands.
  //
  // Hence the fallback label: a settings store that cannot be read costs the
  // user a non-localized word, never a missing picture.
  let label = TRAY_LABELS.en.quitting
  try {
    label = trayLabels(deps?.getSettings().language).quitting
  } catch (err) {
    log.warn('Tray quitting label lookup failed:', err)
  }
  try {
    // One inert line: the drain is not cancellable and every other item would
    // act on services that are already stopping.
    tray?.setContextMenu(Menu.buildFromTemplate([{ label, enabled: false }]))
  } catch (err) {
    log.warn('Tray quitting menu install failed:', err)
  }
  try {
    tray?.setToolTip(`${app.getName()} — ${label}`)
  } catch (err) {
    log.warn('Tray quitting tooltip update failed:', err)
  }
}

/**
 * Quit-time teardown, LAST step before the process exits: release the icon.
 * Disarms first (idempotent) so a caller that skipped `disarmTray()` still
 * gets the L1 gate closed.
 */
export function shutdownTray(): void {
  disarmTray()
  destroyTray()
}

/**
 * Ask for an unread recount. Debounced: sync commits arrive in batches and
 * every one of them would otherwise run the aggregate query.
 */
export function scheduleUnreadRefresh(): void {
  if (!deps || disposed) return
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refreshUnreadNow()
  }, UNREAD_REFRESH_DEBOUNCE_MS)
  refreshTimer.unref?.()
}

/** Recompute and push the unread total to every surface. Never throws. */
export function refreshUnreadNow(): void {
  const d = deps
  if (!d || disposed) return
  try {
    applyUnreadTotal(d.countUnreadTotal(), d.getSettings().language)
  } catch (err) {
    log.warn('Unread refresh failed:', err)
    captureException(err, { source: 'tray:unreadRefresh' })
  }
}

function applyUnreadTotal(total: number, language: string | undefined): void {
  const changed = total !== lastTotal
  lastTotal = total
  if (isTrayActive()) {
    try {
      tray?.setToolTip(formatTrayTooltip(app.getName(), total, trayLabels(language).unreadCount))
    } catch (err) {
      log.warn('Tray tooltip update failed:', err)
    }
  }
  // Dock / Unity badge. Electron reports platform support itself; an
  // unsupported platform returns false and that is not an error.
  try {
    app.setBadgeCount(total)
  } catch (err) {
    log.warn('Badge count update failed:', err)
  }
  if (process.platform === 'win32') applyWindowsOverlay(total)
  // (the overlay lives on the main window only — see applyWindowsOverlay)
  if (changed) {
    try {
      recordEvent('badge.updated', { has_unread: total > 0 })
    } catch { /* telemetry never throws */ }
  }
}

/**
 * Windows taskbar overlay, on the MAIN window only: the overlay marks the
 * application's taskbar button, and Compose / Settings windows carrying their
 * own copy of the same dot would say the same thing three times.
 */
function applyWindowsOverlay(total: number): void {
  const win = deps?.getMainWindow() ?? null
  if (!win || win.isDestroyed()) return
  try {
    const overlay = total > 0
      ? nativeImage.createFromBitmap(renderBadgeDotBitmap(OVERLAY_ICON_SIZE), {
          width: OVERLAY_ICON_SIZE,
          height: OVERLAY_ICON_SIZE,
        })
      : null
    // `description` is the accessibility label; a plain count, never mail text.
    win.setOverlayIcon(overlay, formatBadgeText(total))
  } catch (err) {
    log.warn('Taskbar overlay update failed:', err)
  }
}
