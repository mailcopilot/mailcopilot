/**
 * externalOpenGate — a single, process-wide token-bucket choke point in front
 * of every `shell.openExternal` call in the Electron main process.
 *
 * BACKLOG §2.25 (re-diagnosis) + "P2: Centralized external link gate".
 *
 * Why this exists — the forensic short version. The 2026-05-22 and 2026-06-09
 * incidents were a "browser tab storm": one click on an email link crushed the
 * machine. The earlier §2.25 fix (electron/mailLinkRouter.ts) hardened the
 * RENDERER routing path on a hypothesis that Chromium re-fires the prevented
 * navigation. A live Electron repro disproved that hypothesis: one click
 * produces exactly one `will-navigate`, and the app issued exactly one
 * `shell.openExternal`. The runaway lived BELOW the app — in the OS layer
 * (xdg-open → gio → snap Firefox on Ubuntu), a known infinite re-launch loop
 * (Launchpad bug 1822973 class). The app cannot fix the OS bug, but it CAN
 * refuse to be the amplifier: this gate caps how many external-open requests
 * the app will dispatch in any short window, no matter where they originate
 * (a renderer bug, a queued-event flush after a UI freeze, a compromised
 * renderer, or a legitimate-but-buggy call site).
 *
 * This module is a PURE state machine — NO Electron imports — so the limiter
 * is unit-testable with an injectable clock, exactly like
 * {@link MailLinkRouter} in mailLinkRouter.ts. The Electron wiring (URL
 * validation, `shell.openExternal`, logging, Sentry, metrics) lives in the
 * `openExternalGated` funnel in electron/main.ts.
 *
 * Relationship to mailLinkRouter: complementary, not redundant. The router is
 * a per-webContents defence against renderer-side `mail:link` floods (it gates
 * what reaches `shell.openExternal` from the email-iframe routing path). This
 * gate is the LAST line, global across the whole process, covering EVERY
 * `shell.openExternal` call site (window-open handler, `ui:openExternal` IPC,
 * update dialogs, unsubscribe fallback, OAuth) — including ones the router
 * never sees.
 */

/**
 * Token-bucket capacity — the maximum burst of external opens dispatched
 * back-to-back before the bucket is empty. Five is comfortably above any
 * legitimate burst: a single OAuth flow opens the consent page (and at most a
 * follow-up), an unsubscribe opens one link, a user clicking links does so at
 * human pace. A runaway OS re-launch loop, by contrast, asks for hundreds per
 * second — those are denied once the burst allowance is spent.
 */
export const EXTERNAL_OPEN_BUCKET_CAPACITY = 5

/**
 * Steady-state refill rate: one token every this-many milliseconds. After the
 * burst allowance is spent, the gate lets through at most one external open
 * per {@link EXTERNAL_OPEN_REFILL_INTERVAL_MS} — enough for any real user
 * cadence, far below a re-launch loop's rate, so a sustained storm is bounded
 * to ~0.5 opens/sec instead of hundreds.
 */
export const EXTERNAL_OPEN_REFILL_INTERVAL_MS = 2_000

/**
 * Anomaly threshold: once this many requests have been DENIED since the bucket
 * was last full (i.e. since the start of the current "dry spell"), the storm
 * is no longer plausibly explainable by user behaviour — it is a runaway loop.
 * The gate reports an anomaly EXACTLY ONCE per dry spell (so a single Sentry
 * event fires per storm, not one per suppressed call). The anomaly fires on the
 * denial whose running {@link AcquireResult.suppressedCount} first REACHES this
 * value (denial #10), not the one after it — see {@link ExternalOpenGate.tryAcquire}.
 * Ten denials on top of an already-spent 5-token burst means something issued
 * ~15 external-open requests in a couple of seconds — no human does that.
 */
export const EXTERNAL_OPEN_ANOMALY_THRESHOLD = 10

/**
 * Source classes that route to the TRUSTED token bucket. These external-open
 * call sites dispatch URLs the app itself constructed in response to a direct
 * user action — never URLs derived from email content:
 *   - 'oauth': the provider consent page during account connect (Google /
 *     Microsoft). A hung OAuth flow blocks account setup until timeout.
 *   - 'update_dialog': the releases page opened from the updater's
 *     "install failed" dialog, after the user clicked "Open releases page".
 *
 * They get their OWN bucket so an email-content-driven open storm (which only
 * ever flows through the UNTRUSTED sources — 'window_open', 'ui_ipc',
 * 'mail_link', 'unsubscribe') can never drain the shared allowance and silently
 * starve a legitimate, user-initiated OAuth/update open. Both buckets share the
 * same capacity/refill — the isolation, not a higher limit, is the point.
 */
export const TRUSTED_OPEN_SOURCES = ['oauth', 'update_dialog'] as const
export type TrustedOpenSource = (typeof TRUSTED_OPEN_SOURCES)[number]

/**
 * True when `source` belongs to the {@link TRUSTED_OPEN_SOURCES} class and must
 * be routed to the trusted bucket. Anything else (email-content-driven or
 * renderer-driven opens) uses the untrusted bucket.
 */
export function isTrustedOpenSource(source: string): boolean {
  return (TRUSTED_OPEN_SOURCES as readonly string[]).includes(source)
}

/** Decision returned by {@link ExternalOpenGate.tryAcquire}. */
export interface AcquireResult {
  /** True when a token was available and consumed — the caller may open. */
  allowed: boolean
  /**
   * Present only when `allowed` is false: how many requests have been denied
   * since the bucket was last full (the running size of the current dry
   * spell). Aggregate count only — never tied to a URL.
   */
  suppressedCount?: number
  /**
   * True on EXACTLY ONE denial per dry spell: the request at which
   * {@link suppressedCount} first REACHES {@link EXTERNAL_OPEN_ANOMALY_THRESHOLD}
   * (i.e. denial #10). Lets the caller emit a single Sentry event per storm
   * instead of one per suppressed call. Resets when the bucket next refills to
   * full.
   */
  anomaly?: boolean
}

/**
 * Process-wide token-bucket limiter for `shell.openExternal`.
 *
 * Not thread-aware — Electron's main process is single-threaded, and every
 * external-open request arrives on that thread.
 */
export class ExternalOpenGate {
  /** Current token count (fractional — tokens accrue continuously). */
  private tokens: number
  /** Wall-clock timestamp at which {@link tokens} was last brought current. */
  private lastRefill: number
  /** Denials accumulated since the bucket was last full (the dry-spell size). */
  private deniedSinceFull = 0
  /** True once the anomaly has been reported for the current dry spell. */
  private anomalyReported = false

  /**
   * @param now injectable clock (defaults to `Date.now`) — tests drive it
   *   deterministically instead of relying on wall-clock timing.
   */
  constructor(private readonly now: () => number = Date.now) {
    this.tokens = EXTERNAL_OPEN_BUCKET_CAPACITY
    this.lastRefill = this.now()
  }

  /**
   * Bring {@link tokens} current for the elapsed wall-clock time. Tokens accrue
   * continuously (fractionally) at one per {@link EXTERNAL_OPEN_REFILL_INTERVAL_MS}
   * and are capped at {@link EXTERNAL_OPEN_BUCKET_CAPACITY}. Because the
   * fractional amount is added and `lastRefill` advanced to now, no elapsed
   * time is ever lost to rounding.
   */
  private refill(): void {
    const t = this.now()
    const elapsed = t - this.lastRefill
    if (elapsed <= 0) return
    const accrued = elapsed / EXTERNAL_OPEN_REFILL_INTERVAL_MS
    this.tokens = Math.min(EXTERNAL_OPEN_BUCKET_CAPACITY, this.tokens + accrued)
    this.lastRefill = t
  }

  /**
   * Attempt to consume one token for an external open.
   *
   * Returns `{ allowed: true }` when a token was available (burst within
   * capacity, or steady-state below the refill rate). Otherwise returns
   * `{ allowed: false, suppressedCount, anomaly }` — the open must be dropped.
   *
   * The dry-spell counters ({@link deniedSinceFull} / {@link anomalyReported})
   * reset whenever the bucket has refilled back to full, which only happens
   * after a genuinely quiet period — so a sustained storm keeps the same dry
   * spell (one anomaly), and a new storm after recovery gets its own anomaly.
   */
  tryAcquire(): AcquireResult {
    this.refill()

    // A full bucket means any prior storm has fully drained — the dry spell is
    // over. Reset so the NEXT storm reports its own anomaly exactly once.
    if (this.tokens >= EXTERNAL_OPEN_BUCKET_CAPACITY) {
      this.deniedSinceFull = 0
      this.anomalyReported = false
    }

    if (this.tokens >= 1) {
      this.tokens -= 1
      return { allowed: true }
    }

    this.deniedSinceFull += 1
    let anomaly = false
    // Fire on the denial whose running count REACHES the threshold (denial #10),
    // so the anomaly fires exactly on the documented count rather than one past
    // it. `>=` + the `anomalyReported` latch keeps it to a single event per dry
    // spell.
    if (this.deniedSinceFull >= EXTERNAL_OPEN_ANOMALY_THRESHOLD && !this.anomalyReported) {
      anomaly = true
      this.anomalyReported = true
    }
    return { allowed: false, suppressedCount: this.deniedSinceFull, anomaly }
  }
}
