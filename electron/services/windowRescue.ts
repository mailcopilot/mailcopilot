/**
 * Window rescue service — the single writer of window-bounds corrections.
 *
 * Replaces two earlier, mutually-oscillating mechanisms:
 *  - a main-process display handler that re-clamped the main window on every
 *    display event (including an unmaximize→maximize cycle for maximized
 *    windows), and
 *  - a renderer hook that compared window.outerWidth/outerHeight against
 *    window.screen.avail* on every resize event and invoked a
 *    `win:fitToScreen` IPC.
 * Together with the window manager itself that made three independent
 * controllers fighting over the same geometry; any disagreement (fractional
 * scaling off-by-one, stale window.screen during monitor transitions,
 * work area smaller than the window's minimum size) turned into visible
 * back-and-forth shaking. See docs/ARCHITECTURE.md "Window geometry —
 * single writer / rescue-not-police".
 *
 * Policy invariants (do not weaken without updating ARCHITECTURE.md):
 *  - Rescue, not police: act only when a window is effectively lost
 *    (computeRescueTarget decides; visible windows are never touched).
 *  - Maximized / fullscreen / minimized windows are never touched — the WM
 *    re-places them on display changes itself. In particular, never
 *    unmaximize→maximize.
 *  - All triggers (display events + powerMonitor.resume) coalesce into one
 *    settle timer; a pass that acted (or could not evaluate) schedules a
 *    bounded re-check: at most MAX_PASSES_PER_EPISODE passes per episode,
 *    then exactly ONE autonomous slow retry, then silence until the next
 *    real trigger. A pass that finds nothing to do ends the episode.
 *  - No pass runs while the user is mid interactive resize.
 *  - A single misbehaving window must not prevent rescuing the others.
 */
import { BrowserWindow, screen, powerMonitor } from 'electron'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { computeRescueTarget } from '../windowGeometry'

const log = createLogger('WindowRescue')

/** Quiet period after the last trigger before a rescue pass runs. */
export const SETTLE_MS = 1000
/** Max rescue passes per episode — bounds any WM feedback loop. */
export const MAX_PASSES_PER_EPISODE = 2
/**
 * Trigger gap that starts a new episode, and the delay of the single
 * autonomous retry armed when the pass cap is hit (so a window left
 * off-screen while capped is still rescued without a further event).
 */
export const EPISODE_RESET_MS = 5000

export type WindowRescueOptions = {
  /**
   * Returns true while a user-driven interactive operation (the custom
   * frameless edge-resize) is in progress; rescue passes are deferred, not
   * skipped, so we never fight the user's drag.
   */
  isInteractiveOperationActive?: () => boolean
  /**
   * Forcibly terminate the interactive operation. Invoked once when the
   * deferral cap fires: at that point the "drag" cannot be legitimate (a
   * real one is bounded by the 15s fail-safe in main.ts), and its 16ms
   * setBounds interval would otherwise keep overwriting the rescue's
   * placement every frame (codex-security-review iteration-2 residual:
   * stop→start alternation could hold the flag while the stale interval
   * races the rescue writer).
   */
  stopInteractiveOperation?: () => void
}

/**
 * Cap on consecutive interactive-operation deferrals. A legitimate drag
 * cannot outlive the 15s resize fail-safe in main.ts, so ~20 one-second
 * deferrals can only mean the flag is stuck or a misbehaving renderer is
 * spamming win:startResize to suppress rescue passes — proceed anyway
 * (codex-security-review MEDIUM: unbounded deferral was a rescue-denial
 * vector).
 */
export const MAX_INTERACTIVE_DEFERRALS = 20

let settleTimer: ReturnType<typeof setTimeout> | null = null
let passesInEpisode = 0
let lastEventAt = 0
let interactiveDeferrals = 0
/**
 * The autonomous retry budget: one per trouble episode. Without it a WM that
 * keeps rejecting our setBounds would re-enter "retry → 2 passes → retry"
 * forever (periodic shaking + telemetry spam). Reset by a fresh trigger
 * after an EPISODE_RESET_MS gap, or by any pass that finds nothing to do.
 */
let retryConsumed = false
let standDownLogged = false
let options: WindowRescueOptions = {}
let initialized = false

let onDisplayAdded: (() => void) | null = null
let onDisplayRemoved: (() => void) | null = null
let onDisplayMetricsChanged: (() => void) | null = null
let onPowerResume: (() => void) | null = null

export function initWindowRescue(opts: WindowRescueOptions = {}): void {
  if (initialized) return
  initialized = true
  options = opts
  onDisplayAdded = () => onRescueTrigger('display-added')
  onDisplayRemoved = () => onRescueTrigger('display-removed')
  onDisplayMetricsChanged = () => onRescueTrigger('display-metrics-changed')
  // Resume is a trigger of its own: the WM can rearrange windows during
  // suspend (dock changes applied while asleep) without emitting any
  // display-* event after wake.
  onPowerResume = () => onRescueTrigger('power-resume')
  screen.on('display-added', onDisplayAdded)
  screen.on('display-removed', onDisplayRemoved)
  screen.on('display-metrics-changed', onDisplayMetricsChanged)
  powerMonitor.on('resume', onPowerResume)
}

export function disposeWindowRescue(): void {
  if (onDisplayAdded) screen.removeListener('display-added', onDisplayAdded)
  if (onDisplayRemoved) screen.removeListener('display-removed', onDisplayRemoved)
  if (onDisplayMetricsChanged) screen.removeListener('display-metrics-changed', onDisplayMetricsChanged)
  if (onPowerResume) powerMonitor.removeListener('resume', onPowerResume)
  onDisplayAdded = onDisplayRemoved = onDisplayMetricsChanged = onPowerResume = null
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  passesInEpisode = 0
  lastEventAt = 0
  interactiveDeferrals = 0
  retryConsumed = false
  standDownLogged = false
  options = {}
  initialized = false
}

function onRescueTrigger(kind: string): void {
  const now = Date.now()
  if (now - lastEventAt > EPISODE_RESET_MS) {
    passesInEpisode = 0
    retryConsumed = false
    standDownLogged = false
  }
  lastEventAt = now
  log.debug(`rescue trigger: ${kind}`)
  schedulePass(SETTLE_MS)
}

function schedulePass(delayMs: number): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(runRescuePass, delayMs)
}

/**
 * Arm the single autonomous retry for this episode (no-op once consumed):
 * after the episode gap, start a fresh pass budget and re-evaluate once, so
 * a window left off-screen while capped is still rescued without any
 * further trigger. Once this retry's own budget caps out, the service
 * stands down until the next real trigger.
 */
function scheduleResetRetry(): void {
  if (retryConsumed) return
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    retryConsumed = true
    passesInEpisode = 0
    // Allow the "retry exhausted" stand-down to log once if this retry's
    // budget caps out again.
    standDownLogged = false
    runRescuePass()
  }, EPISODE_RESET_MS)
}

function standDown(context: string): void {
  if (!standDownLogged) {
    standDownLogged = true
    if (retryConsumed) {
      log.warn(`${context}: pass cap (${MAX_PASSES_PER_EPISODE}) reached and autonomous retry exhausted — standing down until the next display/resume trigger`)
    } else {
      log.warn(`${context}: pass cap (${MAX_PASSES_PER_EPISODE}) reached — autonomous retry in ${EPISODE_RESET_MS}ms`)
    }
  }
  scheduleResetRetry()
}

function runRescuePass(): void {
  settleTimer = null
  let moved = 0
  // 'clean' — steady state, episode over; 'acted' — windows were moved,
  // verify once more; 'inconclusive' — could not fully evaluate (transient
  // empty display list, a window threw) — re-check on the same bounded
  // budget instead of silently dropping the rescue opportunity.
  let outcome: 'clean' | 'acted' | 'inconclusive' = 'clean'
  try {
    if (passesInEpisode >= MAX_PASSES_PER_EPISODE) {
      standDown('pre-pass')
      return
    }
    if (options.isInteractiveOperationActive?.()) {
      if (interactiveDeferrals < MAX_INTERACTIVE_DEFERRALS) {
        // Defer, don't drop: re-check after the drag should be over. Does
        // not consume a pass — waiting for the user is not an evaluation.
        interactiveDeferrals++
        schedulePass(SETTLE_MS)
        return
      }
      log.warn(`interactive-operation flag active for ${MAX_INTERACTIVE_DEFERRALS} consecutive deferrals — force-stopping it and proceeding with the pass`)
      // Kill the competing writer before we place windows: a stuck resize
      // interval would overwrite our setBounds every 16ms otherwise.
      options.stopInteractiveOperation?.()
    }
    interactiveDeferrals = 0

    const workAreas = screen.getAllDisplays().map((d) => d.workArea)
    if (workAreas.length === 0) {
      // Transient hotplug/resume state: no displays to rescue onto. Treat as
      // inconclusive — a bounded re-check is armed below.
      outcome = 'inconclusive'
    } else {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (w.isDestroyed() || w.isMinimized() || w.isMaximized() || w.isFullScreen()) continue
          const bounds = w.getBounds()
          const [minWidth, minHeight] = w.getMinimumSize()
          const decision = computeRescueTarget({
            bounds,
            workAreas,
            minSize: { width: minWidth, height: minHeight },
          })
          if (decision.action === 'move') {
            log.info(
              `rescuing window #${w.id} (pass ${passesInEpisode + 1}): ` +
              `${JSON.stringify(bounds)} -> ${JSON.stringify(decision.target)} ` +
              `(workAreas: ${JSON.stringify(workAreas)})`
            )
            w.setBounds(decision.target)
            moved++
          }
        } catch (err) {
          // One bad window (e.g. destroyed between getAllWindows and
          // getBounds) must not abort rescuing the rest.
          outcome = 'inconclusive'
          log.warn('window evaluation failed, continuing with remaining windows', err)
          captureException(err, { source: 'windowRescue' })
        }
      }
      if (moved > 0) outcome = 'acted'
    }
  } catch (err) {
    log.error('rescue pass failed', err)
    captureException(err, { source: 'windowRescue' })
    outcome = 'inconclusive'
  }

  if (outcome === 'clean') {
    // Steady state: everything visible and evaluable. Episode over; restore
    // the full budget for the next trouble period.
    passesInEpisode = 0
    retryConsumed = false
    standDownLogged = false
    return
  }

  passesInEpisode++
  if (outcome === 'acted') {
    recordEvent('window.rescued', { windows_moved: moved, pass: passesInEpisode })
  }
  if (passesInEpisode < MAX_PASSES_PER_EPISODE) {
    // Our own setBounds can provoke WM reactions (panel reflow → workArea
    // change), and an inconclusive pass needs a second look. Re-check after
    // another settle period; the episode cap bounds the total.
    schedulePass(SETTLE_MS)
  } else {
    standDown('post-pass')
  }
}
