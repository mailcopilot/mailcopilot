import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  initTray: vi.fn(),
  applyTraySetting: vi.fn(),
  isTrayActive: vi.fn(() => false),
  scheduleUnreadRefresh: vi.fn(),
  initMailNotifier: vi.fn(),
  seedMailNotifierMarks: vi.fn(() => 3),
  notifyNewMail: vi.fn(),
  forgetAccountNotifications: vi.fn(),
  initDesktopNotifications: vi.fn(),
  presentNewMail: vi.fn(),
  applyLaunchAtLogin: vi.fn(() => ({ supported: true, applied: true })),
  getSettings: vi.fn(() => ({} as Record<string, unknown>)),
  setLaunchAtLoginStatus: vi.fn(),
  captureException: vi.fn(),
  broadcastSettings: vi.fn(),
  getFocusedWindow: vi.fn((): unknown => null),
  countUnreadByFolder: vi.fn((): Array<{ accountId: number; folder: string; unread: number }> => []),
  listFolderPrefs: vi.fn((): Array<Record<string, unknown>> => []),
  getAllFolderPrefs: vi.fn((): Record<number, Array<Record<string, unknown>>> => ({})),
  getAllCachedFolderRoles: vi.fn((): Record<number, Record<string, string>> => ({})),
  getAllCachedMailboxes: vi.fn((): Record<number, Array<{ path: string; specialUse?: string | null }>> => ({})),
  getCachedFolderRoles: vi.fn((): Record<string, string> | null => null),
  presentBackgroundHint: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    isPackaged: true,
    getName: () => 'MailCopilot',
    getPath: () => '/home/u',
    setLoginItemSettings: vi.fn(),
  },
  BrowserWindow: { getFocusedWindow: m.getFocusedWindow },
}))
vi.mock('../../packages/db', () => ({
  countUnreadByFolder: m.countUnreadByFolder,
  listFolderPrefs: m.listFolderPrefs,
  getSyncState: vi.fn(() => undefined),
  getMaxUidForFolder: vi.fn(() => 0),
  getUidsForRulesSince: vi.fn(() => []),
  getMessageByUid: vi.fn(() => undefined),
  getCachedFolderRoles: m.getCachedFolderRoles,
  getAllFolderPrefs: m.getAllFolderPrefs,
  getAllCachedFolderRoles: m.getAllCachedFolderRoles,
  getAllCachedMailboxes: m.getAllCachedMailboxes,
}))
vi.mock('../../packages/net/config', () => ({
  getSettings: m.getSettings,
  listAccounts: vi.fn(() => []),
  setLaunchAtLoginStatus: m.setLaunchAtLoginStatus,
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: m.captureException }))
vi.mock('./tray', () => ({
  initTray: m.initTray,
  applyTraySetting: m.applyTraySetting,
  isTrayActive: m.isTrayActive,
  scheduleUnreadRefresh: m.scheduleUnreadRefresh,
}))
vi.mock('./mailNotifier', () => ({
  initMailNotifier: m.initMailNotifier,
  seedMailNotifierMarks: m.seedMailNotifierMarks,
  notifyNewMail: m.notifyNewMail,
  forgetAccountNotifications: m.forgetAccountNotifications,
}))
vi.mock('./desktopNotifications', () => ({
  initDesktopNotifications: m.initDesktopNotifications,
  presentNewMail: m.presentNewMail,
  presentBackgroundHint: m.presentBackgroundHint,
}))
vi.mock('./launchAtLogin', () => ({ applyLaunchAtLogin: m.applyLaunchAtLogin }))

import {
  initBackgroundMail,
  initTrayIntegration,
  applyTrayEnabled,
  applyLaunchAtLoginSetting,
  syncLaunchAtLogin,
  shouldKeepRunningInBackground,
  noteHiddenToTray,
  noteFolderSynced,
  invalidateUnreadBadge,
  forgetAccountBackgroundState,
} from './backgroundMail'

/** Hooks with the injected broadcast captured, so ordering can be asserted. */
function hooks(isE2E: boolean, onNotificationActivated: () => void = vi.fn()) {
  return { isE2E, onNotificationActivated, broadcastSettings: m.broadcastSettings }
}

const trayHooks = {
  iconPath: '/tmp/icon.png',
  onOpen: vi.fn(),
  onCompose: vi.fn(),
  onCheckMail: vi.fn(),
  getMainWindow: () => null,
}

/** A fake main window whose visibility `onOpen` can flip, as main's does. */
function fakeWindow(visible: boolean, destroyed = false) {
  return {
    visible,
    destroyed,
    isDestroyed: () => destroyed,
    isVisible() { return this.visible },
  }
}

describe('backgroundMail composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.getSettings.mockReturnValue({})
    m.isTrayActive.mockReturnValue(false)
    m.getFocusedWindow.mockReturnValue(null)
    m.countUnreadByFolder.mockReturnValue([])
    m.listFolderPrefs.mockReturnValue([])
    m.getAllFolderPrefs.mockReturnValue({})
    m.getAllCachedFolderRoles.mockReturnValue({})
    m.getAllCachedMailboxes.mockReturnValue({})
    m.getCachedFolderRoles.mockReturnValue(null)
  })

  it('seeds the notifier marks at wiring time', () => {
    initBackgroundMail(hooks(false, vi.fn()))
    expect(m.initDesktopNotifications).toHaveBeenCalledTimes(1)
    expect(m.initMailNotifier).toHaveBeenCalledTimes(1)
    expect(m.seedMailNotifierMarks).toHaveBeenCalledTimes(1)
  })

  it('reports a failed seeding without throwing into startup', () => {
    m.seedMailNotifierMarks.mockImplementationOnce(() => { throw new Error('db locked') })
    expect(() => initBackgroundMail(hooks(false, vi.fn()))).not.toThrow()
    expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), { source: 'seedMailNotifierMarks' })
  })

  it('routes an activated notification to the injected hook', () => {
    const onNotificationActivated = vi.fn()
    initBackgroundMail(hooks(false, onNotificationActivated))
    const deps = m.initDesktopNotifications.mock.calls[0][0] as {
      onActivate: (ref: unknown) => void
      isEnabled: () => boolean
    }
    deps.onActivate({ accountId: 1, folder: 'INBOX', uid: 7 })
    expect(onNotificationActivated).toHaveBeenCalledWith({ accountId: 1, folder: 'INBOX', uid: 7 })
  })

  describe('the notification master switch', () => {
    const isEnabled = () => (m.initDesktopNotifications.mock.calls[0][0] as { isEnabled: () => boolean }).isEnabled()

    it('follows notificationsEnabled', () => {
      initBackgroundMail(hooks(false, vi.fn()))
      m.getSettings.mockReturnValue({ notificationsEnabled: true })
      expect(isEnabled()).toBe(true)
      m.getSettings.mockReturnValue({ notificationsEnabled: false })
      expect(isEnabled()).toBe(false)
    })

    it('is closed under e2e regardless of the setting', () => {
      initBackgroundMail(hooks(true, vi.fn()))
      m.getSettings.mockReturnValue({ notificationsEnabled: true })
      expect(isEnabled()).toBe(false)
    })
  })

  describe('under e2e', () => {
    beforeEach(() => { initBackgroundMail(hooks(true, vi.fn())) })

    it('creates no tray icon and registers no autostart', () => {
      initTrayIntegration(trayHooks)
      expect(m.initTray).not.toHaveBeenCalled()
      expect(m.applyTraySetting).not.toHaveBeenCalled()
      expect(m.applyLaunchAtLogin).not.toHaveBeenCalled()
    })

    it('leaves window-close behaviour as it is today', () => {
      m.getSettings.mockReturnValue({ closeToTray: true })
      m.isTrayActive.mockReturnValue(true)
      expect(shouldKeepRunningInBackground()).toBe(false)
      noteHiddenToTray()
      expect(m.presentBackgroundHint).not.toHaveBeenCalled()
    })

    it('neither notifies nor touches the badge on a sync', () => {
      noteFolderSynced(1, 'INBOX')
      expect(m.notifyNewMail).not.toHaveBeenCalled()
      expect(m.scheduleUnreadRefresh).not.toHaveBeenCalled()
    })

    it('ignores a local badge invalidation', () => {
      invalidateUnreadBadge()
      expect(m.scheduleUnreadRefresh).not.toHaveBeenCalled()
    })

    it('registers no autostart, records no status and pushes nothing', () => {
      expect(applyLaunchAtLoginSetting(true)).toEqual({ supported: false, applied: false })
      syncLaunchAtLogin(true)
      expect(m.applyLaunchAtLogin).not.toHaveBeenCalled()
      expect(m.setLaunchAtLoginStatus).not.toHaveBeenCalled()
      expect(m.broadcastSettings).not.toHaveBeenCalled()
    })

    it('ignores a settings change that would create the tray', () => {
      applyTrayEnabled(true)
      expect(m.applyTraySetting).not.toHaveBeenCalled()
    })

    it('forgets nothing through the e2e gate — teardown is plain cleanup', () => {
      forgetAccountBackgroundState(7)
      expect(m.forgetAccountNotifications).toHaveBeenCalledWith(7)
    })
  })

  describe('outside e2e', () => {
    beforeEach(() => { initBackgroundMail(hooks(false, vi.fn())) })

    it('creates the tray by default and applies the autostart preference', () => {
      m.getSettings.mockReturnValue({})
      initTrayIntegration(trayHooks)
      expect(m.applyTraySetting).toHaveBeenCalledWith(true)
      expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(false, expect.objectContaining({ isPackaged: true }))
    })

    it('does not create the tray when the user turned it off', () => {
      m.getSettings.mockReturnValue({ trayEnabled: false })
      initTrayIntegration(trayHooks)
      expect(m.applyTraySetting).toHaveBeenCalledWith(false)
    })

    it('keeps running in the background only when close-to-tray AND a live icon agree', () => {
      m.getSettings.mockReturnValue({ closeToTray: true })
      m.isTrayActive.mockReturnValue(false)
      expect(shouldKeepRunningInBackground()).toBe(false)

      m.isTrayActive.mockReturnValue(true)
      expect(shouldKeepRunningInBackground()).toBe(true)

      m.getSettings.mockReturnValue({ closeToTray: false })
      expect(shouldKeepRunningInBackground()).toBe(false)
    })

    it('falls back to quitting when the settings store cannot be read', () => {
      m.getSettings.mockImplementationOnce(() => { throw new Error('store unreadable') })
      m.isTrayActive.mockReturnValue(true)
      expect(shouldKeepRunningInBackground()).toBe(false)
    })

    /**
     * §2.228 — the desktop-side confirmation this used to demand is gone. The
     * kept half is the direction that never depended on it: an unreadable
     * preference, or no icon at all, still closes the window normally.
     */
    it('hints where the window went — once per session, and never in e2e', () => {
      noteHiddenToTray()
      noteHiddenToTray()
      expect(m.presentBackgroundHint).toHaveBeenCalledTimes(1)
    })

    /**
     * The hide is the feature; the hint is a courtesy attached to it.
     *
     * `noteHiddenToTray()` is called from `win.on('close')` immediately AFTER
     * `win.hide()` has already run, so anything that escapes it surfaces as an
     * exception on the close path of a window that is already gone — an
     * unreadable settings store (the very failure `shouldKeepRunningInBackground`
     * defends against a few lines up) or an OS that refuses the notification
     * would each do it.
     *
     * It must also stay ONE-SHOT ACROSS THAT FAILURE, which is why the latch is
     * set BEFORE the attempt rather than after a successful one: re-arming on
     * failure turns a persistently broken hint into a nag that retries at every
     * close for the rest of the session. Each test therefore loads a fresh
     * module instance, because the latch is module state the earlier test above
     * has already consumed.
     */
    describe('the one-shot hint survives its own failure', () => {
      async function freshBackgroundMail() {
        vi.resetModules()
        const mod = await import('./backgroundMail')
        mod.initBackgroundMail(hooks(false, vi.fn()))
        return mod
      }

      it('swallows a failing hint and does not re-arm for a retry', async () => {
        const mod = await freshBackgroundMail()
        m.presentBackgroundHint.mockImplementationOnce(() => { throw new Error('no notification service') })
        expect(() => mod.noteHiddenToTray()).not.toThrow()
        expect(m.presentBackgroundHint).toHaveBeenCalledTimes(1)
        // Second hide of the session: still silent, even though the hint the
        // user never saw failed.
        mod.noteHiddenToTray()
        expect(m.presentBackgroundHint).toHaveBeenCalledTimes(1)
      })

      it('swallows an unreadable settings store and does not re-arm either', async () => {
        const mod = await freshBackgroundMail()
        // The language for the hint text is read inside the guarded block, so
        // this throws before `presentBackgroundHint` is ever reached.
        m.getSettings.mockImplementationOnce(() => { throw new Error('store unreadable') })
        expect(() => mod.noteHiddenToTray()).not.toThrow()
        expect(m.presentBackgroundHint).not.toHaveBeenCalled()
        mod.noteHiddenToTray()
        expect(m.presentBackgroundHint).not.toHaveBeenCalled()
      })
    })


    it('notifies and refreshes the unread surfaces on a sync', () => {
      noteFolderSynced(4, 'INBOX')
      expect(m.notifyNewMail).toHaveBeenCalledWith(4, 'INBOX')
      expect(m.scheduleUnreadRefresh).toHaveBeenCalledTimes(1)
    })

    describe('security review MEDIUM-1 — turning the tray off can never strand the user', () => {
      it('shows a hidden window before destroying the last tray icon', () => {
        const win = fakeWindow(false)
        const onOpen = vi.fn(() => { win.visible = true })
        m.isTrayActive.mockReturnValue(true)
        initTrayIntegration({ ...trayHooks, onOpen, getMainWindow: () => win as never })

        applyTrayEnabled(false)
        expect(onOpen).toHaveBeenCalled()
        expect(m.applyTraySetting).toHaveBeenLastCalledWith(false)
      })

      it('RETAINS the tray when the window cannot be made visible', () => {
        const win = fakeWindow(false)
        const onOpen = vi.fn() // show() failed to take effect
        m.isTrayActive.mockReturnValue(true)
        initTrayIntegration({ ...trayHooks, onOpen, getMainWindow: () => win as never })
        ;(m.applyTraySetting as ReturnType<typeof vi.fn>).mockClear()

        applyTrayEnabled(false)
        expect(m.applyTraySetting).not.toHaveBeenCalled()
        expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), { source: 'backgroundMail:trayDisable' })
      })

      it('RETAINS the tray when opening a window throws', () => {
        m.isTrayActive.mockReturnValue(true)
        initTrayIntegration({
          ...trayHooks,
          onOpen: vi.fn(() => { throw new Error('no display') }),
          getMainWindow: () => null,
        })
        ;(m.applyTraySetting as ReturnType<typeof vi.fn>).mockClear()

        applyTrayEnabled(false)
        expect(m.applyTraySetting).not.toHaveBeenCalled()
        expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), { source: 'backgroundMail:trayDisable' })
      })

      it('accepts a freshly created window, which shows itself on ready-to-show', () => {
        let created: ReturnType<typeof fakeWindow> | null = null
        m.isTrayActive.mockReturnValue(true)
        initTrayIntegration({
          ...trayHooks,
          onOpen: vi.fn(() => { created = fakeWindow(false) }),
          getMainWindow: () => created as never,
        })
        ;(m.applyTraySetting as ReturnType<typeof vi.fn>).mockClear()

        applyTrayEnabled(false)
        expect(m.applyTraySetting).toHaveBeenLastCalledWith(false)
      })

      it('does not disturb an already visible window', () => {
        const win = fakeWindow(true)
        const onOpen = vi.fn()
        m.isTrayActive.mockReturnValue(true)
        initTrayIntegration({ ...trayHooks, onOpen, getMainWindow: () => win as never })

        applyTrayEnabled(false)
        expect(onOpen).not.toHaveBeenCalled()
        expect(m.applyTraySetting).toHaveBeenLastCalledWith(false)
      })

      it('does not gate ENABLING the tray, nor a disable with no tray to lose', () => {
        m.isTrayActive.mockReturnValue(false)
        initTrayIntegration({ ...trayHooks, getMainWindow: () => null })
        ;(m.applyTraySetting as ReturnType<typeof vi.fn>).mockClear()

        applyTrayEnabled(true)
        expect(m.applyTraySetting).toHaveBeenLastCalledWith(true)
        applyTrayEnabled(false)
        expect(m.applyTraySetting).toHaveBeenLastCalledWith(false)
      })
    })

    it('forgets the notifier state of a removed account (security review MEDIUM-2)', () => {
      forgetAccountBackgroundState(3)
      expect(m.forgetAccountNotifications).toHaveBeenCalledWith(3)
    })

    it('recounts the badge on a local unread change without running the notifier (review H3)', () => {
      invalidateUnreadBadge()
      expect(m.scheduleUnreadRefresh).toHaveBeenCalledTimes(1)
      expect(m.notifyNewMail).not.toHaveBeenCalled()
    })

    describe('review H4 — the autostart outcome is reported, never assumed', () => {
      it('returns and records a successful registration', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        expect(applyLaunchAtLoginSetting(true)).toEqual({ supported: true, applied: true })
        expect(m.setLaunchAtLoginStatus).toHaveBeenCalledWith(
          expect.objectContaining({ supported: true, applied: true, requested: true }),
        )
      })

      it('returns and records a FAILED registration instead of claiming success', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: false })
        expect(applyLaunchAtLoginSetting(true)).toEqual({ supported: true, applied: false })
        expect(m.setLaunchAtLoginStatus).toHaveBeenCalledWith(
          expect.objectContaining({ supported: true, applied: false, requested: true }),
        )
      })

      it('records an unsupported platform distinctly from a failure', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: false, applied: false })
        expect(applyLaunchAtLoginSetting(false)).toEqual({ supported: false, applied: false })
        expect(m.setLaunchAtLoginStatus).toHaveBeenCalledWith(
          expect.objectContaining({ supported: false, applied: false, requested: false }),
        )
      })

      it('never fails the caller when recording the status throws', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        m.setLaunchAtLoginStatus.mockImplementationOnce(() => { throw new Error('store is read-only') })
        expect(() => applyLaunchAtLoginSetting(true)).not.toThrow()
      })
    })

    // Linux-only by subject matter: XDG_CONFIG_HOME and the ~/.config/autostart
    // .desktop file are a freedesktop mechanism. Windows and macOS register
    // launch-at-login through setLoginItemSettings and never read this path.
    // The assertions below spell the expected directory with forward slashes,
    // so on win32 they failed against path.join's `\custom\config\autostart` —
    // a platform artefact of an inapplicable test, not a defect in the code
    // under test (measured on the Windows stand 2026-08-27).
    describe.skipIf(process.platform !== 'linux')('review M5 — the autostart directory follows XDG_CONFIG_HOME', () => {
      const withEnv = (value: string | undefined, fn: () => void) => {
        const prev = process.env.XDG_CONFIG_HOME
        if (value === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = value
        try { fn() } finally {
          if (prev === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = prev
        }
      }

      it('uses XDG_CONFIG_HOME when it is set to an absolute path', () => {
        withEnv('/custom/config', () => {
          applyLaunchAtLoginSetting(true)
          expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ autostartDir: '/custom/config/autostart' }),
          )
        })
      })

      it('falls back to ~/.config when it is unset', () => {
        withEnv(undefined, () => {
          applyLaunchAtLoginSetting(true)
          expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ autostartDir: '/home/u/.config/autostart' }),
          )
        })
      })

      it('ignores a relative XDG_CONFIG_HOME, as the spec requires', () => {
        withEnv('relative/path', () => {
          applyLaunchAtLoginSetting(true)
          expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ autostartDir: '/home/u/.config/autostart' }),
          )
        })
      })
    })

    describe('review M2 — foreground suppression predicate', () => {
      const isAppFocused = () => (m.initDesktopNotifications.mock.calls[0][0] as { isAppFocused: () => boolean }).isAppFocused()

      it('is true while any window of ours has focus', () => {
        m.getFocusedWindow.mockReturnValue({ isDestroyed: () => false })
        expect(isAppFocused()).toBe(true)
      })

      it('is false with no focused window', () => {
        m.getFocusedWindow.mockReturnValue(null)
        expect(isAppFocused()).toBe(false)
      })

      it('treats a destroyed handle and a throwing lookup as not focused', () => {
        m.getFocusedWindow.mockReturnValue({ isDestroyed: () => true })
        expect(isAppFocused()).toBe(false)
        m.getFocusedWindow.mockImplementation(() => { throw new Error('no window system') })
        expect(isAppFocused()).toBe(false)
      })
    })

    describe('review H2 — the badge total comes from the shared policy', () => {
      const totalFromTray = () => (m.initTray.mock.calls[0][0] as { countUnreadTotal: () => number }).countUnreadTotal()

      beforeEach(() => {
        m.getSettings.mockReturnValue({})
        initTrayIntegration(trayHooks)
      })

      it('counts the inbox and skips a non-inbox folder with no explicit preference', () => {
        m.countUnreadByFolder.mockReturnValue([
          { accountId: 1, folder: 'INBOX', unread: 3 },
          { accountId: 1, folder: 'Archive', unread: 40 },
        ])
        m.getAllCachedFolderRoles.mockReturnValue({ 1: { archive: 'Archive' } })
        expect(totalFromTray()).toBe(3)
      })

      it('counts a folder the user opted into', () => {
        m.countUnreadByFolder.mockReturnValue([{ accountId: 1, folder: 'Archive', unread: 40 }])
        m.getAllCachedFolderRoles.mockReturnValue({ 1: { archive: 'Archive' } })
        m.getAllFolderPrefs.mockReturnValue({ 1: [{ folderPath: 'Archive', visible: true, includeInBadges: true }] })
        expect(totalFromTray()).toBe(40)
      })

      it('drops a folder the user hid from the sidebar', () => {
        m.countUnreadByFolder.mockReturnValue([{ accountId: 1, folder: 'INBOX', unread: 3 }])
        m.getAllFolderPrefs.mockReturnValue({ 1: [{ folderPath: 'INBOX', visible: false, includeInBadges: true }] })
        expect(totalFromTray()).toBe(0)
      })

      it('sums across accounts and short-circuits an empty result', () => {
        m.countUnreadByFolder.mockReturnValue([
          { accountId: 1, folder: 'INBOX', unread: 3 },
          { accountId: 2, folder: 'INBOX', unread: 4 },
        ])
        expect(totalFromTray()).toBe(7)

        m.countUnreadByFolder.mockReturnValue([])
        expect(totalFromTray()).toBe(0)
        // No per-account queries for an empty aggregate.
        expect(m.getAllFolderPrefs).toHaveBeenCalledTimes(1)
      })
    })

    it('gives the notifier the same badge policy the total uses (review H2)', () => {
      const isCounted = (m.initMailNotifier.mock.calls[0][0] as {
        isCountedInBadges: (a: number, f: string) => boolean
      }).isCountedInBadges
      m.listFolderPrefs.mockReturnValue([{ folderPath: 'Archive', visible: true, includeInBadges: false }])
      m.getCachedFolderRoles.mockReturnValue({ archive: 'Archive' })
      expect(isCounted(1, 'Archive')).toBe(false)
      expect(isCounted(1, 'INBOX')).toBe(true)
    })

    describe('round-3 HIGH — the recorded status reaches open windows', () => {
      it('broadcasts settings AFTER writing the status, so the push carries it', () => {
        const order: string[] = []
        m.setLaunchAtLoginStatus.mockImplementation(() => { order.push('write') })
        m.broadcastSettings.mockImplementation(() => { order.push('broadcast') })
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })

        applyLaunchAtLoginSetting(true)
        expect(order).toEqual(['write', 'broadcast'])
      })

      it('pushes a FAILED outcome too — that is the case the note exists for', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: false })
        applyLaunchAtLoginSetting(true)
        expect(m.setLaunchAtLoginStatus).toHaveBeenCalledWith(
          expect.objectContaining({ supported: true, applied: false }),
        )
        expect(m.broadcastSettings).toHaveBeenCalledTimes(1)
      })

      it('pushes the startup outcome as well, not only saves', () => {
        m.getSettings.mockReturnValue({ launchAtLogin: true })
        m.applyLaunchAtLogin.mockReturnValue({ supported: false, applied: false })
        initTrayIntegration(trayHooks)
        expect(m.broadcastSettings).toHaveBeenCalledTimes(1)
      })

      it('does not push when the status could not be recorded', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        m.setLaunchAtLoginStatus.mockImplementationOnce(() => { throw new Error('store is read-only') })
        expect(() => applyLaunchAtLoginSetting(true)).not.toThrow()
        expect(m.broadcastSettings).not.toHaveBeenCalled()
      })

      it('stays silent when nothing was applied because the state is already in effect', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        syncLaunchAtLogin(true)
        expect(m.broadcastSettings).toHaveBeenCalledTimes(1)
        syncLaunchAtLogin(true)
        expect(m.broadcastSettings).toHaveBeenCalledTimes(1)
      })
    })

    describe('round-2 HIGH-2 — the applied-state cache is the service\'s, and retries', () => {
      it('registers at startup and records the status from the first launch', () => {
        m.getSettings.mockReturnValue({ launchAtLogin: true })
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        initTrayIntegration(trayHooks)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(true, expect.anything())
        expect(m.setLaunchAtLoginStatus).toHaveBeenCalledWith(
          expect.objectContaining({ supported: true, applied: true, requested: true }),
        )
      })

      it('skips the OS call when the desired state is already in effect', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(1)
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(1)
      })

      it('RETRIES the same desired state after a failed attempt', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: false })
        syncLaunchAtLogin(true)
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(2)

        // Once it succeeds, the repetition stops.
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(3)
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(3)
      })

      it('retries after a STARTUP failure — the defect this replaced', () => {
        m.getSettings.mockReturnValue({ launchAtLogin: true })
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: false })
        initTrayIntegration(trayHooks)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(1)

        // A later save asking for the SAME state must reach the OS again.
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(2)
      })

      it('does not retry an unsupported platform — there is nothing to retry', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: false, applied: false })
        syncLaunchAtLogin(true)
        syncLaunchAtLogin(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(1)
      })

      it('applies a CHANGED desire even while an earlier one is in effect', () => {
        m.applyLaunchAtLogin.mockReturnValue({ supported: true, applied: true })
        syncLaunchAtLogin(true)
        syncLaunchAtLogin(false)
        expect(m.applyLaunchAtLogin).toHaveBeenLastCalledWith(false, expect.anything())
        expect(m.applyLaunchAtLogin).toHaveBeenCalledTimes(2)
      })
    })

    it('passes the AppImage path to the autostart writer when there is one', () => {
      const prev = process.env.APPIMAGE
      process.env.APPIMAGE = '/opt/MailCopilot.AppImage'
      try {
        applyLaunchAtLoginSetting(true)
        expect(m.applyLaunchAtLogin).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ execPath: '/opt/MailCopilot.AppImage' }),
        )
      } finally {
        if (prev === undefined) delete process.env.APPIMAGE
        else process.env.APPIMAGE = prev
      }
    })
  })
})
