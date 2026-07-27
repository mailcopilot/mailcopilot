/**
 * mailLinkRouter — per-webContents idempotency + circuit breaker for the
 * mail-link routing in `configureExternalLinks` (electron/main.ts).
 *
 * BACKLOG §2.25 — runaway browser-tab storm (re-diagnosed 2026-06-09).
 *
 * CORRECTED root cause (the original hypothesis below was DISPROVEN). A live
 * Electron repro showed that one user click on an email link produces EXACTLY
 * ONE `will-navigate` event, and the app issued EXACTLY ONE
 * `shell.openExternal`. There is no Chromium "re-fires the prevented
 * navigation" loop — the app-side routing path was innocent for the tab
 * storm. The runaway lived BELOW the app, in the OS layer: on the affected
 * Ubuntu machine `shell.openExternal` → xdg-open → gio → snap Firefox entered
 * a known infinite re-launch loop (Launchpad bug 1822973 class), spawning
 * ~2200 browser launches from a single open. The forensic write-up is in
 * BACKLOG §2.25.
 *
 * The original (incorrect) hypothesis was that `configureExternalLinks` wiring
 * both `will-navigate` and `will-frame-navigate` made Chromium emit more than
 * one navigation event per click, each forwarding another `mail:link`. The
 * repro did not reproduce that.
 *
 * Why this module still exists — defence in depth, NOT the fix for that
 * incident. It remains a legitimate guard against renderer-side or
 * queued-event `mail:link` floods (a renderer bug, an event backlog flushing
 * after a UI freeze, or a compromised renderer) collapsing duplicate firings
 * and hard-stopping an anomalous burst on the routing path. The actual
 * machine-crushing OS re-launch loop is addressed one layer down by the
 * process-wide token-bucket gate in electron/externalOpenGate.ts, which caps
 * how many `shell.openExternal` calls the app dispatches in any short window
 * regardless of origin.
 *
 * This module is a PURE state machine (no Electron imports) so its behaviour
 * is reproducible in a unit test without importing the 9000-LoC `main.ts`
 * hotspot.
 *
 * Two defence layers, both always active:
 *
 *   1. FIRST-LINE COLLAPSE — {@link MailLinkRouter.shouldEmit} collapses
 *      every navigation event resolving to the same external URL within
 *      {@link DEDUP_WINDOW_MS} into exactly ONE `mail:link` emission. This
 *      handles the common case: Chromium's duplicate firings for one click.
 *
 *   2. SECOND-LINE HARD STOP — a real CIRCUIT BREAKER. When accepted
 *      emissions exceed {@link ANOMALY_THRESHOLD} within
 *      {@link ANOMALY_WINDOW_MS}, the router enters a SUPPRESSION state:
 *      {@link MailLinkRouter.shouldEmit} returns `false` for ALL urls
 *      (not just the duplicated one) until a cooldown elapses. This is what
 *      actually STOPS a runaway — not just slows it.
 *
 * Why a breaker and not only dedup (CLAUDE.md §7 — root-cause honesty):
 * the URL-keyed dedup alone only collapses *identical* URLs within 600ms.
 * If Chromium sustains a `preventDefault`-retry loop spaced just over
 * {@link DEDUP_WINDOW_MS}, or the loop cycles through *distinct* URLs, the
 * dedup lets one emission through every window — the runaway is SLOWED, not
 * STOPPED, and `shell.openExternal` keeps firing forever. We do NOT have
 * definitive evidence whether the real-world bug is a bounded burst or a
 * sustained loop. The circuit breaker is correct under that uncertainty: it
 * is harmless if the bug is a bounded burst (the burst ends before the
 * breaker matters), and decisive if it is a sustained loop (the breaker
 * latches and no further `mail:link` is emitted). Once the breaker trips,
 * `emitMailLink` in main.ts never calls `webContents.send` again until
 * cooldown, so the renderer stops opening tabs and `shell.openExternal`
 * stops being invoked — the runaway genuinely halts.
 *
 * State is per-webContents — callers key one router instance per window.
 */

/**
 * Two navigation events resolving to the IDENTICAL external URL within this
 * window are treated as the same user click. A real second click on the
 * same link within 600ms is implausible; even if it happens, suppressing
 * the duplicate tab is the strictly safer outcome on a phishing-prone
 * surface (Low finding, codex-bg-review §2.25 fix-loop 1 — accepted and
 * documented behaviour, not a regression). Any renderer-side duplicate
 * `mail:link` emissions for one logical click (e.g. an event backlog
 * flushing after a freeze) land well inside it.
 */
export const DEDUP_WINDOW_MS = 600

/**
 * Anomaly detection: more than {@link ANOMALY_THRESHOLD} accepted
 * `mail:link` emissions within {@link ANOMALY_WINDOW_MS} on the same
 * webContents is not legitimate user behaviour — it is the runaway loop.
 * Tuned per BACKLOG §2.25 AC (e): ">3 openExternal in a ~2s window".
 *
 * Headroom for normal use: a human cannot click and confirm the phishing
 * prompt for 4 DISTINCT links inside 2 seconds, so a legitimate user never
 * trips the breaker. Distinct-URL clicks are the only way to reach the
 * threshold at all — identical-URL repeats are already collapsed by the
 * dedup layer before they can count.
 */
export const ANOMALY_WINDOW_MS = 2_000
export const ANOMALY_THRESHOLD = 3

/**
 * Circuit-breaker cooldown. Once the breaker trips, {@link MailLinkRouter.shouldEmit}
 * returns `false` for EVERY url, and the breaker only re-closes after a
 * genuinely QUIET period of this length — i.e. this much time with NO
 * navigation events offered to {@link MailLinkRouter.shouldEmit} at all.
 *
 * The cooldown is measured from the LAST suppressed attempt, not from the
 * trip instant. This is the property that makes the breaker a real hard
 * stop rather than a slow leak:
 *   - A SUSTAINED runaway keeps offering urls → every offer pushes the
 *     quiet-deadline forward → the breaker never re-closes → emissions are
 *     halted entirely after the trip (not one-per-cooldown forever).
 *   - A BOUNDED burst stops offering urls → no more attempts arrive → the
 *     quiet period elapses → the breaker self-heals and normal clicks work
 *     again.
 *
 * Chosen equal to {@link ANOMALY_WINDOW_MS}: long enough that any plausible
 * renderer-side `mail:link` flood (which fires several times per second)
 * keeps the breaker latched, short enough that a real user is not locked out
 * for an unreasonable time after a transient burst ends.
 */
export const BREAKER_COOLDOWN_MS = ANOMALY_WINDOW_MS

/**
 * Protocols that may be opened externally (via `shell.openExternal`) or routed
 * through the renderer's link-warning UI. Anything else in an email is dropped.
 */
export const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Custom protocol the renderer rewrites email `<a href>` values into
 * (`rewriteMailHtmlLinks`). A `mailcopilot-link://` navigation carries the
 * original href in the `u` query param and optional link text in `t`.
 */
export const ROUTED_LINK_PROTOCOL = 'mailcopilot-link:'

/**
 * True when `rawUrl` is a protocol we are willing to open externally. Pure —
 * no Electron imports — so it is unit-testable and shared between the
 * `will-frame-navigate` decision logic and the `setWindowOpenHandler` /
 * `shell:openExternal` callers in `main.ts`.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    return ALLOWED_EXTERNAL_PROTOCOLS.has(u.protocol)
  } catch {
    return false
  }
}

/**
 * Parse a `mailcopilot-link://` routed URL back into the original href + text.
 * Returns `null` for any URL that is not a routed mail link (including
 * malformed input). Pure — no Electron imports.
 */
export function parseRoutedMailLink(rawUrl: string): { href: string; text: string } | null {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== ROUTED_LINK_PROTOCOL) return null
    const href = u.searchParams.get('u')
    if (!href) return null
    const text = u.searchParams.get('t') || ''
    return { href, text }
  } catch {
    return null
  }
}

/**
 * Decision returned by {@link decideMailLinkAction} for a single
 * `will-frame-navigate` event observed inside a (sandboxed) email iframe.
 *
 *  - `routed` — the iframe tried to navigate to a `mailcopilot-link://` URL
 *    (a link the renderer rewrote). `payload` carries the de-referenced
 *    original href/text; the caller must `preventDefault()` and emit it.
 *  - `raw` — a *raw* external URL (one that escaped `rewriteMailHtmlLinks`)
 *    is navigating the iframe. `payload.unsafeBypass` is always `true` so the
 *    renderer shows the phishing prompt unconditionally. Caller must
 *    `preventDefault()` and emit it.
 *  - `ignore` — main-frame navigation, or a URL that is neither routed nor an
 *    allowed external protocol. The caller does nothing (lets it proceed /
 *    or it is simply not our concern).
 */
export type MailLinkAction =
  | { kind: 'routed'; payload: { href: string; text: string } }
  | { kind: 'raw'; payload: { href: string; text: string; unsafeBypass: true } }
  | { kind: 'ignore' }

/**
 * Pure decision function for the `will-frame-navigate` interceptor in
 * `configureExternalLinks` (electron/main.ts).
 *
 * It takes ONLY the two fields the handler needs from the Electron 40
 * `WebContentsWillFrameNavigateEventParams` details object — `url` and
 * `isMainFrame` — and returns the {@link MailLinkAction} the handler should
 * dispatch. Keeping this pure (no Electron import, no `preventDefault`/`send`
 * side effects) means the routing decision is unit-testable with the REAL
 * details-object shape, independent of the `main.ts` hotspot.
 *
 * Logic (unchanged from the original handler — only the extraction is new):
 *   1. Main-frame navigations are not our concern here → `ignore`.
 *   2. A `mailcopilot-link://` URL → `routed` with the de-referenced href.
 *   3. A raw allowed-external URL that escaped the renderer's rewriter →
 *      `raw` with `unsafeBypass: true` so the phishing prompt always fires.
 *   4. Anything else (unknown protocol, garbage, empty) → `ignore`.
 */
export function decideMailLinkAction(details: {
  url: string
  isMainFrame: boolean
}): MailLinkAction {
  if (details.isMainFrame) return { kind: 'ignore' }

  const routed = parseRoutedMailLink(details.url)
  if (routed) return { kind: 'routed', payload: routed }

  // Safety net: a raw external link that escaped rewriteMailHtmlLinks() is
  // forced through the renderer's phishing prompt rather than opened directly.
  if (isAllowedExternalUrl(details.url)) {
    return { kind: 'raw', payload: { href: details.url, text: '', unsafeBypass: true } }
  }

  return { kind: 'ignore' }
}

/** Result of {@link MailLinkRouter.noteEmit}. */
export interface NoteEmitResult {
  /** True when this emission pushed the recent count past the threshold. */
  anomaly: boolean
  /** Number of accepted emissions within the anomaly window (incl. this one). */
  recentCount: number
  /**
   * True only on the emission that TRIPS the breaker (the transition into
   * suppression). Lets the caller report the runaway to Sentry exactly once
   * per trip instead of on every subsequent anomalous emission.
   */
  breakerTripped: boolean
}

/**
 * Per-webContents dedup + circuit-breaker state machine for routed mail
 * links.
 *
 * Not thread-aware — Electron's main process is single-threaded, and all
 * navigation events for one webContents arrive on that thread.
 */
export class MailLinkRouter {
  /** URL → timestamp of the last accepted emission for that URL. */
  private readonly lastEmitByUrl = new Map<string, number>()
  /** Timestamps of recent accepted emissions, for anomaly detection. */
  private recentEmits: number[] = []
  /**
   * True once the circuit breaker has tripped; stays true until a genuine
   * quiet period (see {@link breakerQuietDeadline}) elapses.
   */
  private breakerOpen = false
  /**
   * While the breaker is open, the timestamp at or after which it may
   * re-close — provided no further navigation event is offered in the
   * meantime. Every offer made while the breaker is open (every call to
   * {@link shouldEmit} during suppression) pushes this deadline forward by
   * {@link BREAKER_COOLDOWN_MS}, so a sustained runaway never lets the
   * breaker re-close. `0` when the breaker is closed.
   */
  private breakerQuietDeadline = 0

  /**
   * @param now injectable clock (defaults to `Date.now`) — tests drive it
   *   deterministically instead of relying on wall-clock timing.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * True while the circuit breaker is OPEN (a runaway has been detected and
   * a quiet period has not yet elapsed). Exposed for tests and diagnostics.
   *
   * Has a side effect: when the quiet deadline has passed it CLOSES the
   * breaker (clears state and drains the recent-emit history) so the router
   * resumes from a clean slate. This makes the breaker self-healing for
   * bounded bursts without needing a separate timer. A sustained runaway
   * never reaches this point because each offered url in {@link shouldEmit}
   * pushes the deadline forward.
   */
  isBreakerOpen(): boolean {
    if (!this.breakerOpen) return false
    if (this.now() >= this.breakerQuietDeadline) {
      // Quiet period elapsed with no further attempts — close the breaker
      // and reset history. If a runaway were still ongoing it would have
      // kept pushing breakerQuietDeadline forward and we'd never be here.
      this.breakerOpen = false
      this.breakerQuietDeadline = 0
      this.recentEmits = []
      return false
    }
    return true
  }

  /**
   * Decide whether a navigation event for `url` should produce a
   * `mail:link` emission.
   *
   * Returns false when EITHER:
   *   - the circuit breaker is OPEN (a runaway was detected — ALL urls are
   *     suppressed; this is the hard stop), OR
   *   - an identical-URL emission already happened within
   *     {@link DEDUP_WINDOW_MS} (this firing is a duplicate of one click).
   *
   * The breaker is checked FIRST so that, once a runaway is detected, no
   * url — not even a never-seen-before one — gets through. That is what
   * makes the runaway actually STOP rather than merely slow down. Crucially,
   * every offer made while the breaker is open EXTENDS the suppression: a
   * sustained loop that keeps calling `shouldEmit` keeps the breaker latched
   * indefinitely, so emissions are halted entirely, not leaked one-per-
   * cooldown.
   *
   * Pure-ish: it prunes expired dedup entries as a side effect so the map
   * cannot grow unbounded, but does not record the new emission — call
   * {@link noteEmit} for that once the caller actually emits.
   */
  shouldEmit(url: string): boolean {
    // Hard stop first: while the breaker is open every url is suppressed.
    // isBreakerOpen() self-heals once a quiet period has elapsed.
    if (this.isBreakerOpen()) {
      // This offer arrived while suppressed — the runaway is still active,
      // so push the quiet deadline forward. The breaker can only re-close
      // after BREAKER_COOLDOWN_MS with zero offers.
      this.breakerQuietDeadline = this.now() + BREAKER_COOLDOWN_MS
      return false
    }

    const t = this.now()
    // Prune dedup entries that have aged out so a long-lived window does
    // not accumulate one entry per distinct URL ever clicked.
    for (const [k, ts] of this.lastEmitByUrl) {
      if (t - ts >= DEDUP_WINDOW_MS) this.lastEmitByUrl.delete(k)
    }
    const last = this.lastEmitByUrl.get(url)
    if (last !== undefined && t - last < DEDUP_WINDOW_MS) return false
    return true
  }

  /**
   * Record an accepted emission for `url`. Must be called exactly once per
   * `mail:link` actually sent, immediately after a `shouldEmit` → true.
   *
   * Returns whether the recent-emit count constitutes a runaway-loop
   * anomaly and, via {@link NoteEmitResult.breakerTripped}, whether THIS
   * emission was the one that opened the circuit breaker. When the breaker
   * trips here, every subsequent {@link shouldEmit} returns `false` until
   * {@link BREAKER_COOLDOWN_MS} elapses — so this emission is the LAST one
   * that gets through; the runaway stops here.
   */
  noteEmit(url: string): NoteEmitResult {
    const t = this.now()
    this.lastEmitByUrl.set(url, t)
    // Keep only emissions inside the anomaly window.
    this.recentEmits = this.recentEmits.filter(ts => t - ts < ANOMALY_WINDOW_MS)
    this.recentEmits.push(t)
    const recentCount = this.recentEmits.length
    const anomaly = recentCount > ANOMALY_THRESHOLD

    // Trip the breaker on the transition into anomaly. `breakerOpen` being
    // false here means the breaker was closed when this emission was
    // accepted — so this is a fresh trip, reported to Sentry exactly once.
    // The quiet deadline starts now; any further offer extends it.
    let breakerTripped = false
    if (anomaly && !this.breakerOpen) {
      this.breakerOpen = true
      this.breakerQuietDeadline = t + BREAKER_COOLDOWN_MS
      breakerTripped = true
    }

    return { anomaly, recentCount, breakerTripped }
  }
}
