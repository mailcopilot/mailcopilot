/**
 * §2.99 — composition root for tray + background operation + new-mail
 * notifications.
 *
 * The three services underneath (tray, mailNotifier, desktopNotifications) hold
 * the decisions; this module binds them to the real cache, the real settings
 * store and the real OS, so main.ts contributes only what it alone owns: the
 * window handles and the e2e flag. Hotspot policy — main.ts gets calls, not
 * another hundred lines of adapter objects.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import {
  countUnreadByFolder,
  listFolderPrefs,
  getSyncState,
  getMaxUidForFolder,
  getUidsForRulesSince,
  getMessageByUid,
  getCachedFolderRoles,
  getAllFolderPrefs,
  getAllCachedFolderRoles,
  getAllCachedMailboxes,
} from '../../packages/db'
import { getFolderRole, isFolderCountedInBadges, sumBadgeUnread } from '../../packages/core'
import { getSettings, listAccounts, setLaunchAtLoginStatus } from '../../packages/net/config'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import type { FolderRoleMap } from '../unreadBadge'
import { initTray, applyTraySetting, isTrayActive, scheduleUnreadRefresh } from './tray'
import { initMailNotifier, seedMailNotifierMarks, notifyNewMail, forgetAccountNotifications } from './mailNotifier'
import { initDesktopNotifications, presentNewMail, presentBackgroundHint, type MailRef } from './desktopNotifications'
import { applyLaunchAtLogin } from './launchAtLogin'

const log = createLogger('BackgroundMail')

export type BackgroundMailHooks = {
  /**
   * True under e2e (`computeIsE2E` — env flag AND unpackaged build). Suppresses
   * the tray icon, OS notifications and badge writes so specs see today's
   * behaviour; the flag is DERIVED in main.ts, never read from the environment
   * here.
   */
  isE2E: boolean
  /** Bring the app forward and hand the renderer a message ref. */
  onNotificationActivated: (ref: MailRef) => void
  /**
   * Push the CURRENT settings to every window (main's `broadcastSettingsChanged`).
   *
   * Needed because `launchAtLoginStatus` is written by this service AFTER the
   * save handler has already broadcast (review round 3): a Settings window
   * listening to `settings:changed` would otherwise hold the previous — or
   * absent — outcome until something else caused a broadcast. Injected rather
   * than imported so the service stays free of window handles.
   */
  broadcastSettings: () => void
}

let hooks: BackgroundMailHooks = {
  isE2E: false,
  onNotificationActivated: () => {},
  broadcastSettings: () => {},
}

/** One-shot latch for the "we are still running" hint (see noteHiddenToTray). */
let backgroundHintShown = false

/**
 * Does this folder's unread count reach a badge?
 *
 * Resolved through the SHARED policy in packages/core (review H2): the same
 * function the in-app per-account badge uses, fed here from the folder
 * preferences and cached mailboxes main already has. `specialUse` comes from
 * the cached mailbox list so the role is derived exactly as the renderer
 * derives it, rather than re-guessed from role paths alone.
 */
function badgeContextFor(accountId: number, folder: string) {
  const pref = listFolderPrefs(accountId).find(p => p.folderPath === folder)
  const mailbox = (getAllCachedMailboxes()[accountId] ?? []).find(m => m.path === folder)
  const roles = getCachedFolderRoles(accountId) ?? {}
  return {
    pref: pref ? { visible: pref.visible, includeInBadges: pref.includeInBadges } : null,
    role: getFolderRole(folder, mailbox?.specialUse ?? null, roles),
  }
}

/**
 * Total unread across every account under the shared badge policy.
 *
 * Reads the three "all accounts" accessors once per recount rather than once
 * per row — this runs behind a debounce, but a badge refresh must not become a
 * per-folder query storm.
 */
function computeBadgeTotal(): number {
  const rows = countUnreadByFolder()
  if (rows.length === 0) return 0
  const prefsByAccount = getAllFolderPrefs()
  const rolesByAccount = getAllCachedFolderRoles()
  const mailboxesByAccount = getAllCachedMailboxes()
  return sumBadgeUnread(rows, (accountId, folder) => {
    const pref = (prefsByAccount[accountId] ?? []).find(p => p.folderPath === folder)
    const mailbox = (mailboxesByAccount[accountId] ?? []).find(m => m.path === folder)
    return {
      pref: pref ? { visible: pref.visible, includeInBadges: pref.includeInBadges } : null,
      role: getFolderRole(folder, mailbox?.specialUse ?? null, rolesByAccount[accountId] ?? {}),
    }
  })
}

/**
 * Wire the notification path and seed the per-folder marks.
 *
 * Called at module scope in main.ts, for the same reason the rule-watermark
 * seeding is: every folder this install already knows about must get its mark
 * BEFORE anything can sync, or the first launch of this build would announce
 * the whole existing archive as new mail (§2.86 in the other direction).
 */
export function initBackgroundMail(next: BackgroundMailHooks): void {
  hooks = next
  // A fresh wiring knows nothing about what the OS currently has registered.
  launchAtLoginInEffect = null
  backgroundHintShown = false
  initDesktopNotifications({
    onActivate: ref => hooks.onNotificationActivated(ref),
    // The user switch is the same one that governed the old renderer-side
    // notifications — §2.99 moved the decision, not the preference.
    isEnabled: () => !hooks.isE2E && getSettings().notificationsEnabled !== false,
    // Review M2 — the renderer path suppressed toasts while the user was
    // looking at the app; keep that. Any focused window of ours counts: a user
    // typing in Compose is no more in need of an interruption than one reading
    // the list.
    isAppFocused: () => {
      try {
        const focused = BrowserWindow.getFocusedWindow()
        return !!focused && !focused.isDestroyed()
      } catch {
        // Unknown focus is treated as "not focused": showing a toast the user
        // did not need is recoverable, swallowing new mail silently is not.
        return false
      }
    },
  })
  initMailNotifier({
    listAccountIds: () => listAccounts().map(a => a.id),
    listFolderPrefs: aid => listFolderPrefs(aid),
    getUidValidity: (aid, folder) => getSyncState(aid, folder)?.uidValidity ?? null,
    getMaxUidForFolder,
    getUidsSince: getUidsForRulesSince,
    getMessageByUid: (aid, folder, uid) => {
      const row = getMessageByUid(aid, folder, uid)
      if (!row) return undefined
      return { uid: row.uid, subject: row.subject ?? null, from: row.from ?? row.fromAddr ?? null, unread: !!row.unread }
    },
    getSettings,
    getFolderRoles: aid => getCachedFolderRoles(aid) as FolderRoleMap | null,
    isCountedInBadges: (aid, folder) => isFolderCountedInBadges(badgeContextFor(aid, folder)),
    present: presentNewMail,
    log: { info: msg => log.info(msg), warn: (msg, err) => log.warn(msg, err) },
    captureException,
  })
  try {
    const seeded = seedMailNotifierMarks()
    if (seeded > 0) log.info(`Seeded new-mail marks for ${seeded} folder(s)`)
  } catch (err) {
    log.error('Seeding new-mail marks failed:', err)
    captureException(err, { source: 'seedMailNotifierMarks' })
  }
}

export type TrayIntegrationHooks = {
  iconPath: string
  onOpen: () => void
  onCompose: () => void
  onCheckMail: () => void
  getMainWindow: () => Electron.BrowserWindow | null
}

/**
 * The autostart state we know is actually IN EFFECT (review round 2, HIGH-2).
 *
 * `null` means "never applied in this session", which is why startup always
 * calls through. It lives here, next to the code that learns the outcome,
 * rather than in main.ts: main used to cache the DESIRED value directly, so a
 * startup registration that FAILED still recorded the wish as done and every
 * later save then saw "nothing changed" and skipped the OS call — permanently.
 * One owner, one rule, applied identically at startup and on save.
 */
let launchAtLoginInEffect: boolean | null = null

/**
 * Bring the OS autostart registration in line with `desired`, if it is not
 * already known to be there.
 *
 * The cache advances ONLY on an outcome that settles the question: applied, or
 * a platform that cannot do this at all (nothing to retry). A supported-but-
 * failed attempt deliberately leaves the cache alone, so the next save — or the
 * next launch — tries again.
 */
export function syncLaunchAtLogin(desired: boolean): void {
  if (hooks.isE2E) return
  if (launchAtLoginInEffect === desired) return
  const outcome = applyLaunchAtLoginSetting(desired)
  if (outcome.applied || !outcome.supported) launchAtLoginInEffect = desired
}

/**
 * Retained so the "tray off" reaction can put a window back on screen before it
 * removes the icon (security review MEDIUM-1). Not the only way back — see
 * `applyTrayEnabled` for why the protection stays regardless.
 */
let trayIntegration: TrayIntegrationHooks | null = null

/** Create the tray (if the setting allows) and register the autostart state. */
export function initTrayIntegration(trayHooks: TrayIntegrationHooks): void {
  if (hooks.isE2E) return
  trayIntegration = trayHooks
  initTray({
    iconPath: trayHooks.iconPath,
    onOpen: trayHooks.onOpen,
    onCompose: trayHooks.onCompose,
    onCheckMail: trayHooks.onCheckMail,
    onQuit: () => app.quit(),
    countUnreadTotal: computeBadgeTotal,
    getMainWindow: trayHooks.getMainWindow,
    getSettings,
  })
  applyTraySetting(getSettings().trayEnabled !== false)
  // Startup goes through the same gate as a save (HIGH-2): the outcome seeds
  // the applied-state cache, and `launchAtLoginStatus` is written now rather
  // than at the first settings change, so the first Settings window the user
  // opens already tells the truth about the registration.
  syncLaunchAtLogin(getSettings().launchAtLogin === true)
}

/**
 * Is there a window the user can actually see — creating or un-hiding one if
 * not? (security review MEDIUM-1)
 *
 * Returns false when it could not establish that, which is the whole point: the
 * caller then keeps the tray rather than removing the on-screen route back to
 * the app while the app has no window.
 */
function ensureRecoverableWindow(): boolean {
  const integration = trayIntegration
  if (!integration) return false
  try {
    const before = integration.getMainWindow()
    const hadWindow = !!before && !before.isDestroyed()
    if (hadWindow && before.isVisible()) return true
    integration.onOpen()
    const after = integration.getMainWindow()
    if (!after || after.isDestroyed()) return false
    // A window that merely was HIDDEN must be visible now — that is the state
    // this exists to repair. A freshly created one is not visible yet by
    // design (`show: false` until `ready-to-show`), and showing itself is its
    // own contract, so its existence is the answer.
    return hadWindow ? after.isVisible() : true
  } catch {
    return false
  }
}

/**
 * React to a settings change: tray presence (and with it, its localized menu).
 *
 * Turning the tray OFF is the one transition that can leave the user staring at
 * nothing: with `closeToTray` armed the main window may already be hidden, and
 * destroying the icon in that state removes the visible affordance out from
 * under a running, window-less app (AC3, found by security review MEDIUM-1).
 * Reopening still brings it back — relaunching on Linux/Windows, the dock icon
 * on macOS; that is the standing guarantee `shouldKeepRunningInBackground`
 * documents, and it holds here too — but a setting the user just changed must
 * not require them to go and reopen the app to see its effect. The icon is the
 * affordance in front; those routes are the backstop behind it, and neither
 * stands in for the other, which is why the protection stays. So a visible
 * window is established FIRST, as immediate care for the person at the
 * keyboard, and if that cannot be done the tray is KEPT: the preference loses
 * to the affordance, which is the safe direction and is visible (the icon
 * stays) rather than silent.
 */
export function applyTrayEnabled(enabled: boolean): void {
  if (hooks.isE2E) return
  if (!enabled && isTrayActive() && !ensureRecoverableWindow()) {
    log.warn('Keeping the tray icon: no visible window could be established, so removing it would leave a running app with nothing on screen to reach for')
    captureException(new Error('tray disable refused — no visible window could be established'), {
      source: 'backgroundMail:trayDisable',
    })
    return
  }
  applyTraySetting(enabled)
}

/**
 * Drop every trace of an account from the background-mail state (security
 * review MEDIUM-2).
 *
 * Account ids are REUSED (`max + 1`), which is the §2.165 lesson in a different
 * place: a mark left behind under a deleted id becomes the starting watermark
 * of the next account to take that id, and a notification still queued for it
 * would show the removed mailbox's subject and open a ref into it.
 */
export function forgetAccountBackgroundState(accountId: number): void {
  forgetAccountNotifications(accountId)
}

/**
 * Where freedesktop autostart entries live (review M5).
 *
 * `XDG_CONFIG_HOME` is the spec's answer and is set by every session that moves
 * the config root; `~/.config` is the spec's own fallback, not a guess. A
 * relative value is ignored — the spec says such a value must be treated as
 * unset, and writing to a relative path would land the entry next to whatever
 * the process cwd happens to be.
 */
function autostartDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(app.getPath('home'), '.config')
  return path.join(base, 'autostart')
}

/**
 * Apply the autostart preference and RECORD WHAT ACTUALLY HAPPENED (review H4).
 *
 * Returns the outcome so the caller can decide whether the desired state may be
 * cached: a failed write must be retried on the next save, not remembered as
 * done. The same outcome is persisted to the main-only `launchAtLoginStatus`
 * field, which reaches the Settings window through the `settings:get` /
 * `settings:changed` paths it already uses — no new channel, and the user's own
 * `launchAtLogin` choice is never silently flipped underneath them.
 */
export function applyLaunchAtLoginSetting(enabled: boolean): { supported: boolean; applied: boolean } {
  if (hooks.isE2E) return { supported: false, applied: false }
  const outcome = applyLaunchAtLogin(enabled, {
    platform: process.platform,
    isPackaged: app.isPackaged,
    setLoginItemSettings: settings => app.setLoginItemSettings(settings),
    autostartDir: autostartDir(),
    execPath: process.env.APPIMAGE || process.execPath,
    appName: app.getName(),
    fs: {
      mkdirSync: (dir, options) => { fs.mkdirSync(dir, options) },
      writeFileSync: (file, data, encoding) => { fs.writeFileSync(file, data, encoding) },
      rmSync: (file, options) => { fs.rmSync(file, options) },
    },
  })
  if (!outcome.supported) log.info('Launch at login is not supported by this build/platform')
  else if (!outcome.applied) log.warn('Launch at login could not be applied — the toggle will retry on the next save')
  try {
    setLaunchAtLoginStatus({
      supported: outcome.supported,
      applied: outcome.applied,
      requested: enabled,
      at: new Date().toISOString(),
    })
    // Round 3 — the status is written after `settings:save` has already
    // broadcast, and at startup outside any save at all, so it needs its own
    // push or an open Settings window keeps showing the previous outcome. A
    // second broadcast is deliberately preferred over reordering the save
    // handler: it is correct no matter when this runs, and it does not make
    // the UI update wait on an OS registration.
    hooks.broadcastSettings()
  } catch (err) {
    // The status is a report, not the mechanism: failing to record or publish
    // it must not fail the settings save that triggered it.
    log.warn('Recording or publishing the launch-at-login status failed:', err)
  }
  return outcome
}

/**
 * Is close-to-tray armed AND is there a tray icon to come back from?
 *
 * Deliberately the whole decision, and deliberately synchronous. §2.228 added a
 * third condition — a desktop-side confirmation that the icon it created is one
 * the shell actually took — and it was removed again, because the premise under
 * it was false: hiding is recoverable WITHOUT any icon at all. There are two
 * routes back, and together they cover every platform we ship:
 *  - Linux/Windows — relaunching from the launcher (`app.on('second-instance')`);
 *  - macOS — clicking the dock icon (`app.on('activate')`), where
 *    `second-instance` never fires at all.
 * Both call `showMainWindow()` in main.ts, which restores a minimized window,
 * shows a hidden one and focuses it, or creates one if there is none; all three
 * wirings are pinned in main.backgroundMail.test.ts. The tray menu carries Quit
 * on top of that. So the worst case a broken icon can produce is "the user
 * reopens the app the way they always do" — while the gate cost a live, working
 * feature on every desktop whose icon is served by the legacy X11 tray, where no
 * confirmation was obtainable. No comparable client (Thunderbird, Slack,
 * Telegram) asks the desktop before hiding either.
 */
export function shouldKeepRunningInBackground(): boolean {
  if (hooks.isE2E) return false
  try {
    return getSettings().closeToTray === true && isTrayActive()
  } catch {
    // Unreadable settings keep the visible behaviour: a window that closes is
    // never a surprise, a window that vanishes on a preference we could not
    // read is.
    return false
  }
}

/**
 * The window just went to the tray — say so, ONCE per session.
 *
 * The way back exists (the tray icon, and a second launch re-shows the window);
 * what was missing is that a user who has never met close-to-tray has no reason
 * to look for it. Once per session, silent, and only while the user has
 * notifications on, so it stays a hint rather than a nag.
 */
export function noteHiddenToTray(): void {
  if (hooks.isE2E || backgroundHintShown) return
  backgroundHintShown = true
  try {
    presentBackgroundHint(getSettings().language)
  } catch (err) {
    // A hint that failed must not disturb the window that already hid. Only the
    // error's class name is logged — the settings read can quote a store path.
    log.warn(`Background hint could not be presented (${err instanceof Error ? err.name : 'unknown'})`)
  }
}

/**
 * One reaction point for "this folder's cached mail just changed": decide
 * whether to announce it and refresh the unread surfaces. Every eligibility
 * question (sync mode, hidden folders, master switch, marks) belongs to the
 * notifier, so call sites stay one line.
 */
export function noteFolderSynced(accountId: number, folder: string): void {
  if (hooks.isE2E) return
  notifyNewMail(accountId, folder)
  scheduleUnreadRefresh()
}

/**
 * "Something changed the unread count locally" — recount the badge (review H3).
 *
 * Separate from `noteFolderSynced` because these seams must NOT run the
 * notifier: reading, archiving, deleting, moving, snoozing and waking mail
 * changes what is unread without anything arriving. Tying the badge to sync
 * alone left it stale until the next pass — indefinitely so while offline.
 * Debounced by the tray service, so call sites stay one line and may fire per
 * message.
 */
export function invalidateUnreadBadge(): void {
  if (hooks.isE2E) return
  scheduleUnreadRefresh()
}
