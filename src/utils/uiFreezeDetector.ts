const TICK_MS = 100
const FREEZE_THRESHOLD_MS = 200

let timer: ReturnType<typeof setTimeout> | null = null
let last = 0
let started = false

type FreezeReport = {
  lagMs: number
  deltaMs: number
  at: string
  visibilityState: DocumentVisibilityState
}

function reportFreeze(info: FreezeReport) {
  try {
    void window.api?.invoke('log:uiFreeze', info)?.catch(() => {})
  } catch {
    /* main process unavailable */
  }
  console.warn('[UiFreezeDetector] UI blocked', info)
}

function tick() {
  const now = performance.now()
  const delta = now - last
  const lag = delta - TICK_MS
  // Ignore ticks fired while the tab/window was hidden — the browser throttles timers.
  if (lag >= FREEZE_THRESHOLD_MS && document.visibilityState === 'visible') {
    reportFreeze({
      lagMs: Math.round(lag),
      deltaMs: Math.round(delta),
      at: new Date().toISOString(),
      visibilityState: document.visibilityState,
    })
  }
  last = now
  timer = setTimeout(tick, TICK_MS)
}

/**
 * Starts a self-scheduling timer that measures its own firing lag.
 * If the event loop is blocked for longer than FREEZE_THRESHOLD_MS, the next
 * tick is delayed — we log the lag to main process so the freeze is visible
 * in main.log and can be correlated with ongoing IPC handlers.
 */
export function startUiFreezeDetector() {
  if (started) return
  started = true
  last = performance.now()
  timer = setTimeout(tick, TICK_MS)
  // One-shot startup ping so we can confirm the detector is actually loaded
  // by looking at main.log (otherwise zero reports is ambiguous).
  try {
    void window.api?.invoke('log:uiFreeze', {
      lagMs: 0,
      deltaMs: 0,
      at: new Date().toISOString(),
      visibilityState: document.visibilityState,
      startup: true,
    })?.catch(() => {})
  } catch {
    /* ignore */
  }
  // Reset baseline when the tab becomes visible again — otherwise the long
  // "hidden" interval would be reported as a false freeze.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') last = performance.now()
  })
}

export function stopUiFreezeDetector() {
  if (timer) clearTimeout(timer)
  timer = null
  started = false
}
