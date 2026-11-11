// Background update check: the one place that decides whether an automatic
// request to the update feed may leave this machine, and when.
//
// Every automatic check is an HTTPS request to our feed: a GET for the channel
// metadata file (its name carries the platform and architecture), so the feed
// sees the client's IP address and that. The check itself sends no app version;
// downloading an update does (file names carry version numbers). That is a
// transfer to a system the user did not name, so it is allowed only when BOTH
// hold:
//
//   1. the user has not switched it off (`updateCheckEnabled`, default on), and
//   2. this is not a genuine first run. A first run is a profile with NO
//      consent record in any version and NO account: the first-run screen is
//      where such a user sees the choice, so nothing is sent before the record
//      exists. Every other profile — an older consent version, a record the
//      screen would ask about again, a profile from before consent existed —
//      keeps checking: everyone who has not switched updates off gets them.
//
// Enforced here, in main, at the moment of the action: a timer that fires after
// the setting was turned off, or on a first run before the screen was answered,
// sends nothing. A check the updater library has ALREADY started may still
// complete (it may be waiting on its config read, and retries on ECONNREFUSED);
// switching off stops new checks, it does not abort the library's (nor an
// automatic download it has already begun). The renderer
// can neither open the gate nor arm a timer.
//
// The manual "Check for updates" button is an explicit request and does not go
// through this module.

/** Interval between automatic checks. */
export const UPDATE_CHECK_INTERVAL_MS = 3_600_000

/** The settings this module reads, structurally (no import of the full type). */
export interface UpdateCheckSettings {
  updateCheckEnabled?: boolean
  autoUpdateEnabled?: boolean
  /** Only its PRESENCE matters here (any version, any shape), never its content. */
  telemetryConsent?: unknown
}

/**
 * May an automatic check run right now?
 *
 * `updateCheckEnabled` absent means "on" (the default; existing profiles).
 * Without a consent record the profile is a genuine first run only if it also
 * has no account; the account lookup is consulted only then.
 *
 * THROWS when settings (or, on the first-run branch, the account list) cannot
 * be read: an unreadable store proves nothing, so the caller must not send —
 * and, being a transient fault, must not stop scheduling either. The scheduler
 * treats a throw as "not now, ask again at the next tick".
 */
export function isBackgroundUpdateCheckAllowed(
  read: () => UpdateCheckSettings,
  hasAccounts: () => boolean,
): boolean {
  const settings = read()
  if (settings.updateCheckEnabled === false) return false
  if (typeof settings.telemetryConsent === 'object' && settings.telemetryConsent !== null) return true
  return hasAccounts()
}

/**
 * Should electron-updater download on its own?
 *
 * An automatic download cannot happen without a check, so with background
 * checks off it is off too — even if a manual check finds an update, the user
 * then gets the Download button. The stored `autoUpdateEnabled` preference is
 * not rewritten: it applies again as soon as checks are switched back on.
 */
export function computeAutoDownload(settings: UpdateCheckSettings, canSelfUpdate: boolean): boolean {
  return settings.autoUpdateEnabled === true && settings.updateCheckEnabled !== false && canSelfUpdate
}

/**
 * electron-updater attaches `x-user-staging-id` — a random UUID it persists in
 * `<userData>/.updaterId` — to every channel-file request, which would let the
 * feed link one installation's checks over time and across IP changes. Staged
 * rollouts are decided locally from the stored value, not from this header, so
 * the header is pinned to a constant: the request then identifies no
 * installation, which is what the privacy policy says it does. `requestHeaders`
 * win over the library's own (`computeFinalHeaders`).
 */
export const NEUTRAL_STAGING_USER_ID = '00000000-0000-0000-0000-000000000000'

export function buildUpdateRequestHeaders(token?: string): Record<string, string> {
  return {
    ...(token ? { 'PRIVATE-TOKEN': token } : {}),
    'x-user-staging-id': NEUTRAL_STAGING_USER_ID,
  }
}

export interface UpdateSchedulerDeps {
  /**
   * Live permission, re-read before every request and on every `sync()`.
   * `false` = not allowed (the schedule stops on `sync()`); a THROW = could not
   * tell right now (nothing is sent, the schedule keeps going and asks again).
   */
  isAllowed: () => boolean
  /** Issue one check. Must not throw; a throw is swallowed anyway. */
  runCheck: () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface UpdateScheduler {
  /** Arm the schedule after app ready. Before this, `sync()` does nothing. */
  start: () => void
  /** Re-evaluate after a settings change or a recorded first-run answer. */
  sync: () => void
}

export function createUpdateScheduler(deps: UpdateSchedulerDeps): UpdateScheduler {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let started = false
  let handle: unknown = null
  // Time of the last automatic request, so that switching the setting off and
  // on again cannot be used to send a request per click: a resume waits out
  // what is left of the interval.
  let lastCheckAt: number | null = null

  type Permission = 'allowed' | 'denied' | 'unreadable'
  const permission = (): Permission => {
    try { return deps.isAllowed() ? 'allowed' : 'denied' } catch { return 'unreadable' }
  }

  const disarm = () => {
    if (handle === null) return
    clearTimer(handle)
    handle = null
  }

  const fire = () => {
    handle = null
    // Re-checked at the moment of the request: the state may have changed while
    // the timer was pending. An explicit refusal ends the schedule here, exactly
    // as `sync()` would (no timer is left behind; the next `sync()` re-arms if
    // the refusal is lifted). A read that FAILED is not a refusal: re-arm, so
    // one transient settings-read failure cannot silence background checks for
    // the rest of the session.
    const state = permission()
    if (state === 'denied') return
    if (state === 'unreadable') {
      arm(UPDATE_CHECK_INTERVAL_MS)
      return
    }
    lastCheckAt = now()
    try { deps.runCheck() } catch { /* a failed check must not stop the schedule */ }
    arm(UPDATE_CHECK_INTERVAL_MS)
  }

  const arm = (delayMs: number) => {
    if (delayMs <= 0) {
      fire()
      return
    }
    handle = setTimer(fire, delayMs)
  }

  const sync = () => {
    if (!started) return
    const state = permission()
    if (state === 'denied') {
      disarm()
      return
    }
    if (handle !== null) return
    // Could not read the state: send nothing now, but keep planning — the next
    // tick reads again. Dropping the schedule here would turn one transient
    // read failure at start or on a settings change into "never checks again".
    if (state === 'unreadable') {
      arm(UPDATE_CHECK_INTERVAL_MS)
      return
    }
    arm(lastCheckAt === null ? 0 : Math.max(0, UPDATE_CHECK_INTERVAL_MS - (now() - lastCheckAt)))
  }

  return {
    start: () => {
      started = true
      sync()
    },
    sync,
  }
}

export interface BackgroundUpdateChecksDeps extends Pick<UpdateSchedulerDeps, 'now' | 'setTimer' | 'clearTimer'> {
  /** Live settings read (`getSettings` in main). */
  readSettings: () => UpdateCheckSettings
  /** Is there any configured account? Asked only for a profile with no consent record. */
  hasAccounts: () => boolean
  /** The updater's check call. Only this module's timer reaches it automatically. */
  checkForUpdates: () => Promise<unknown>
  /** Usage event for an automatic check; must not throw (a throw is swallowed). */
  recordAutoCheck: () => void
}

/**
 * The wiring main.ts uses, as one injectable function so a test drives the same
 * code path: permission read from the live settings on every tick, the request
 * issued through the updater. The manual button does not use this — it calls the
 * updater directly, as an explicit request.
 */
export function createBackgroundUpdateChecks(deps: BackgroundUpdateChecksDeps): UpdateScheduler {
  return createUpdateScheduler({
    isAllowed: () => isBackgroundUpdateCheckAllowed(deps.readSettings, deps.hasAccounts),
    runCheck: () => {
      try { deps.recordAutoCheck() } catch { /* telemetry must not block */ }
      void deps.checkForUpdates().catch(() => {})
    },
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
  })
}

export interface UpdatePolicyDeps {
  /** The schedule to re-evaluate; only `sync()` is used. */
  scheduler: Pick<UpdateScheduler, 'sync'>
  canSelfUpdate: boolean
  getAutoDownload: () => boolean
  setAutoDownload: (next: boolean) => void
}

export interface UpdatePolicy {
  /**
   * Bring the runtime in line with the settings that were just persisted.
   * `read` is called at most once and may throw.
   */
  apply: (read: () => UpdateCheckSettings) => void
}

/**
 * The single writer of the runtime update policy. BOTH paths that can change
 * `updateCheckEnabled` (settings:save and the first-run answer) go through it,
 * so they cannot drift: auto-download follows the setting (an automatic
 * download cannot happen without a check), and the schedule is re-evaluated
 * with no restart.
 *
 * The schedule re-evaluation does NOT depend on the settings read here: the
 * scheduler reads the settings itself and treats a failed read as "ask again at
 * the next tick". A transient failure of THIS read must therefore cost at most
 * the auto-download flip, never the resumption of the checks — on a fresh
 * profile that read happens right after the first-run answer, and losing the
 * `sync()` there left the session with no timer at all.
 */
export function createUpdatePolicy(deps: UpdatePolicyDeps): UpdatePolicy {
  return {
    apply: read => {
      try {
        const want = computeAutoDownload(read(), deps.canSelfUpdate)
        if (deps.getAutoDownload() !== want) deps.setAutoDownload(want)
      } catch { /* the flag keeps its previous value; the schedule below is independent */ }
      try { deps.scheduler.sync() } catch { /* sync() does not throw; belt and braces */ }
    },
  }
}
