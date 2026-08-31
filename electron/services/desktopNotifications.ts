/**
 * §2.99/§2.228 — presents the two things this app says through the OS
 * notification stack: a new-mail toast, and the one-shot hint that a close hid
 * the window into the tray.
 *
 * Thin on purpose: WHAT to announce is decided by mailNotifier.ts (which has
 * no electron import and is tested without a display server) and, for the
 * hint, by services/backgroundMail.ts, which owns the once-per-session latch;
 * HOW it reads comes from the pure trayLabels.ts. This module is the electron
 * boundary — `Notification`, its click, and the metric.
 *
 * PII rule (CLAUDE.md §8): subject and sender are shown to the user on their
 * own machine and go NOWHERE else. Nothing here logs them, and the metric
 * carries a count bucket only. The click payload is identifiers
 * (accountId / folder / uid) — the renderer looks the message up itself.
 */

import { Notification } from 'electron'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { buildNewMailNotification, trayLabels } from '../trayLabels'
import type { NewMailNotification } from './mailNotifier'

const log = createLogger('Notifications')

export type MailRef = { accountId: number; folder: string; uid: number }

export interface DesktopNotificationDeps {
  /** User clicked the toast — bring the app forward on this message. */
  onActivate: (ref: MailRef) => void
  /** False in e2e and whenever notifications must stay silent. */
  isEnabled: () => boolean
  /**
   * Is the user looking at the app right now? (review M2)
   *
   * The renderer path this replaced skipped the toast when the window was
   * visible AND focused — mail landing in a list the user is already reading is
   * not news, and a toast over it is pure interruption. The predicate is
   * injected so the decision stays testable without a display server.
   */
  isAppFocused: () => boolean
}

let deps: DesktopNotificationDeps | null = null

/**
 * A bounded, content-free label for a failure (security review LOW-2).
 *
 * The exception we catch below comes from the platform notification stack,
 * which is handed the SUBJECT and SENDER of a message. A platform that echoes
 * the rejected payload in its error message would otherwise put that text into
 * the local log and into Sentry through a raw `err` pass-through — the exact
 * shape CLAUDE.md §8 forbids. So nothing but a code-shaped token or the error's
 * class name survives, and anything unusual collapses to `unknown`.
 */
function failureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code
  const name = (err as { name?: unknown } | null | undefined)?.name
  if (typeof name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(name)) return name
  return 'unknown'
}

export function initDesktopNotifications(next: DesktopNotificationDeps): void {
  deps = next
}

/**
 * §2.228 — "the window went to the tray, here is where it went".
 *
 * Shown at most once a session by the caller. Carries no mail, so the focused-
 * app suppression does not apply (the app was just hidden); it does obey the
 * user's notifications switch, because a user who turned toasts off has already
 * answered this question.
 */
export function presentBackgroundHint(lang: string | undefined): void {
  const d = deps
  if (!d) return
  try {
    if (!d.isEnabled()) return
    if (!Notification.isSupported()) return
    const labels = trayLabels(lang)
    new Notification({
      title: labels.backgroundHintTitle,
      body: labels.backgroundHintBody,
      silent: true,
    }).show()
  } catch (err) {
    // Same synthetic-only rule as below: nothing from the platform is echoed.
    log.warn(`Showing the background hint failed (code=${failureCode(err)})`)
  }
}

/** Show one new-mail notification. Never throws — the caller is a sync path. */
export function presentNewMail(payload: NewMailNotification): void {
  const d = deps
  if (!d) return
  try {
    if (!d.isEnabled()) return
    // Foreground arrival: consumed, not shown. The mark and the badge have
    // already moved by the time we get here, so nothing is re-announced later.
    if (d.isAppFocused()) {
      recordEvent('notification.suppressed', { reason: 'app_focused' })
      return
    }
    if (!Notification.isSupported()) {
      // Unsigned macOS builds and headless Linux sessions land here. Documented
      // limitation, not a failure mode to work around.
      log.info('OS notifications are not supported in this environment')
      return
    }
    const { title, body } = buildNewMailNotification({
      lang: payload.lang,
      count: payload.count,
      subject: payload.subject,
      from: payload.from,
    })
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      try {
        recordEvent('notification.clicked', {})
      } catch { /* telemetry never breaks a click */ }
      try {
        d.onActivate({ accountId: payload.accountId, folder: payload.folder, uid: payload.uid })
      } catch (err) {
        const code = failureCode(err)
        log.error(`Notification activation failed (code=${code})`)
        captureException(new Error('notification activation failed'), {
          source: 'notifications:activate',
          code,
        })
      }
    })
    notification.show()
    // Aggregate only: how many toasts, and whether a toast covered one message
    // or a batch. No account id, no folder, no text.
    recordEvent('notification.shown', { batched: payload.count > 1 })
  } catch (err) {
    // Synthetic only — see `failureCode`. The raw error may quote the mail we
    // just tried to display.
    const code = failureCode(err)
    log.warn(`Showing a new-mail notification failed (code=${code})`)
    captureException(new Error('notification present failed'), {
      source: 'notifications:present',
      code,
    })
  }
}
