import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type FakeTrayInstance = {
  destroyed: boolean
  tooltip: string | null
  menu: unknown
  handlers: Map<string, () => void>
  setContextMenu: ReturnType<typeof vi.fn>
  setToolTip: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

const {
  mockRecordEvent, mockCaptureException, mockSetBadgeCount, trayInstances,
  mockBuildFromTemplate, lastMenuTemplate, mockCreateFromPath, mockCreateFromBitmap, FakeTray,
} = vi.hoisted(() => {
  const trayInstances: FakeTrayInstance[] = []
  const lastMenuTemplate: { current: Array<{ label?: string; type?: string; enabled?: boolean; click?: () => void }> } = { current: [] }
  class FakeTray {
    destroyed = false
    tooltip: string | null = null
    menu: unknown = null
    handlers = new Map<string, () => void>()
    setContextMenu = vi.fn((menu: unknown) => { this.menu = menu })
    setToolTip = vi.fn((text: string) => { this.tooltip = text })
    on = vi.fn((event: string, handler: () => void) => { this.handlers.set(event, handler) })
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed = () => this.destroyed
    constructor() {
      trayInstances.push(this as unknown as FakeTrayInstance)
    }
  }
  return {
    mockRecordEvent: vi.fn(),
    mockCaptureException: vi.fn(),
    mockSetBadgeCount: vi.fn(),
    trayInstances,
    lastMenuTemplate,
    FakeTray,
    mockBuildFromTemplate: vi.fn((template: Array<{ label?: string; type?: string; enabled?: boolean; click?: () => void }>) => {
      lastMenuTemplate.current = template
      return { template }
    }),
    mockCreateFromPath: vi.fn(() => ({
      isEmpty: () => false,
      resize: vi.fn(() => ({ isEmpty: () => false })),
    })),
    mockCreateFromBitmap: vi.fn(() => ({ kind: 'bitmap' })),
  }
})

vi.mock('electron', () => ({
  app: { getName: () => 'MailCopilot', setBadgeCount: mockSetBadgeCount },
  Menu: { buildFromTemplate: mockBuildFromTemplate },
  Tray: FakeTray,
  nativeImage: { createFromPath: mockCreateFromPath, createFromBitmap: mockCreateFromBitmap },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mockCaptureException }))
vi.mock('../metrics', () => ({ recordEvent: mockRecordEvent }))

import {
  initTray,
  applyTraySetting,
  destroyTray,
  isTrayActive,
  refreshUnreadNow,
  scheduleUnreadRefresh,
  disarmTray,
  shutdownTray,
  UNREAD_REFRESH_DEBOUNCE_MS,
  type TrayServiceDeps,
} from './tray'

function makeDeps(overrides: Partial<TrayServiceDeps> = {}): TrayServiceDeps {
  return {
    iconPath: '/tmp/icon.png',
    onOpen: vi.fn(),
    onCompose: vi.fn(),
    onCheckMail: vi.fn(),
    onQuit: vi.fn(),
    countUnreadTotal: vi.fn(() => 3),
    getMainWindow: vi.fn(() => null),
    getSettings: vi.fn(() => ({ language: 'en', trayEnabled: true })),
    ...overrides,
  }
}

function labels(): string[] {
  return lastMenuTemplate.current.filter(i => i.label).map(i => i.label as string)
}

describe('tray service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trayInstances.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    destroyTray()
    vi.useRealTimers()
  })

  it('creates the icon only when the setting asks for it', () => {
    initTray(makeDeps())
    expect(isTrayActive()).toBe(false)

    applyTraySetting(false)
    expect(isTrayActive()).toBe(false)
    expect(trayInstances).toHaveLength(0)

    applyTraySetting(true)
    expect(isTrayActive()).toBe(true)
    expect(mockRecordEvent).toHaveBeenCalledWith('tray.created', expect.objectContaining({ outcome: 'created' }))
  })

  it('does not create a second icon on repeated calls', () => {
    initTray(makeDeps())
    applyTraySetting(true)
    applyTraySetting(true)
    expect(trayInstances).toHaveLength(1)
  })

  it('destroys the icon when the setting is turned off, and isTrayActive follows', () => {
    initTray(makeDeps())
    applyTraySetting(true)
    const instance = trayInstances[0]
    applyTraySetting(false)
    expect(instance.destroy).toHaveBeenCalled()
    expect(isTrayActive()).toBe(false)
  })

  it('reports a tray host that refuses the icon instead of throwing', () => {
    mockCreateFromPath.mockImplementationOnce(() => { throw new Error('no tray host') })
    initTray(makeDeps())
    expect(() => applyTraySetting(true)).not.toThrow()
    expect(isTrayActive()).toBe(false)
    expect(mockRecordEvent).toHaveBeenCalledWith('tray.created', expect.objectContaining({ outcome: 'failed' }))
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { source: 'tray:create' })
  })

  /**
   * The language-change repaint goes through `applyTraySetting(true)` — its
   * "already there" branch rebuilds the menu, and it is the branch that carries
   * the `disposed` guard. The separate `refreshTrayMenu()` export was deleted
   * with this test rewritten onto that path: it had no production caller and
   * was the one repaint route that could paint the live menu back over the
   * quitting one after `disarmTray()`.
   */
  it('builds a localized menu and rebuilds it on demand', () => {
    const settings = { language: 'ru', hiddenUnreadFolders: [] as string[], trayEnabled: true }
    initTray(makeDeps({ getSettings: () => settings }))
    applyTraySetting(true)
    expect(labels()).toEqual(['Открыть MailCopilot', 'Новое письмо', 'Проверить почту', 'Выход'])

    settings.language = 'de'
    applyTraySetting(true)
    expect(trayInstances).toHaveLength(1)
    expect(labels()).toEqual(['MailCopilot öffnen', 'Neue Nachricht', 'Nachrichten abrufen', 'Beenden'])
  })

  it('routes menu clicks to the injected callbacks and records the action', () => {
    const deps = makeDeps()
    initTray(deps)
    applyTraySetting(true)
    const items = lastMenuTemplate.current.filter(i => i.click)
    items[0].click?.()
    items[1].click?.()
    items[2].click?.()
    items[3].click?.()
    expect(deps.onOpen).toHaveBeenCalled()
    expect(deps.onCompose).toHaveBeenCalled()
    expect(deps.onCheckMail).toHaveBeenCalled()
    expect(deps.onQuit).toHaveBeenCalled()
    expect(mockRecordEvent).toHaveBeenCalledWith('tray.menu_action', { action: 'quit' })
  })

  it('contains a failing menu action rather than propagating it', () => {
    const deps = makeDeps({ onCompose: vi.fn(() => { throw new Error('compose blew up') }) })
    initTray(deps)
    applyTraySetting(true)
    const compose = lastMenuTemplate.current.filter(i => i.click)[1]
    expect(() => compose.click?.()).not.toThrow()
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { source: 'tray:menuAction', action: 'compose' })
  })

  it('publishes the total the shared badge policy produced', () => {
    initTray(makeDeps())
    applyTraySetting(true)
    refreshUnreadNow()
    expect(trayInstances[0].tooltip).toBe('MailCopilot — 3 unread')
    expect(mockSetBadgeCount).toHaveBeenLastCalledWith(3)
  })

  it('drops the count from the tooltip when nothing is unread', () => {
    initTray(makeDeps({ countUnreadTotal: () => 0 }))
    applyTraySetting(true)
    refreshUnreadNow()
    expect(trayInstances[0].tooltip).toBe('MailCopilot')
    expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0)
  })

  it('debounces refresh requests into a single recount', () => {
    const deps = makeDeps()
    initTray(deps)
    applyTraySetting(true)
    ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()

    scheduleUnreadRefresh()
    scheduleUnreadRefresh()
    scheduleUnreadRefresh()
    expect(deps.countUnreadTotal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS)
    expect(deps.countUnreadTotal).toHaveBeenCalledTimes(1)
  })

  it('keeps the badge working with no tray icon, and never throws on a failing query', () => {
    initTray(makeDeps({ countUnreadTotal: () => { throw new Error('db down') } }))
    expect(() => refreshUnreadNow()).not.toThrow()
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { source: 'tray:unreadRefresh' })
  })

  describe('review M6 — a tray that cannot really exist must not claim to', () => {
    it('refuses an empty icon image instead of arming close-to-tray behind it', () => {
      mockCreateFromPath.mockImplementationOnce(() => ({
        isEmpty: () => true,
        resize: vi.fn(),
      }) as unknown as ReturnType<typeof mockCreateFromPath>)
      initTray(makeDeps())
      applyTraySetting(true)
      expect(trayInstances).toHaveLength(0)
      expect(isTrayActive()).toBe(false)
      expect(mockRecordEvent).toHaveBeenCalledWith('tray.created', expect.objectContaining({ outcome: 'failed' }))
    })

    it('refuses an image whose resize came back empty', () => {
      mockCreateFromPath.mockImplementationOnce(() => ({
        isEmpty: () => false,
        resize: vi.fn(() => ({ isEmpty: () => true })),
      }) as unknown as ReturnType<typeof mockCreateFromPath>)
      initTray(makeDeps())
      applyTraySetting(true)
      expect(isTrayActive()).toBe(false)
    })

    it('destroys the half-created tray when initialisation throws after construction', () => {
      mockBuildFromTemplate.mockImplementationOnce(() => { throw new Error('menu build failed') })
      initTray(makeDeps())
      applyTraySetting(true)
      expect(trayInstances).toHaveLength(1)
      expect(trayInstances[0].destroy).toHaveBeenCalled()
      expect(isTrayActive()).toBe(false)
    })
  })

  describe('review L1 — the quit gate', () => {
    it('ignores refresh requests arriving after shutdownTray during the drain', () => {
      const deps = makeDeps()
      initTray(deps)
      applyTraySetting(true)
      shutdownTray()
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()

      scheduleUnreadRefresh()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 4)
      refreshUnreadNow()
      expect(deps.countUnreadTotal).not.toHaveBeenCalled()
      expect(isTrayActive()).toBe(false)
    })

    it('keeps a PENDING recount when the icon is turned off (review round 2, MEDIUM-2)', () => {
      const deps = makeDeps()
      initTray(deps)
      applyTraySetting(true)
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()
      mockSetBadgeCount.mockClear()

      // A local mutation schedules a recount, then the user disables the tray
      // before the debounce fires. The badge must still be updated.
      scheduleUnreadRefresh()
      applyTraySetting(false)
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS)
      expect(deps.countUnreadTotal).toHaveBeenCalledTimes(1)
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(3)
    })

    it('drops a pending recount on the QUIT path', () => {
      const deps = makeDeps()
      initTray(deps)
      applyTraySetting(true)
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()

      scheduleUnreadRefresh()
      shutdownTray()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 4)
      expect(deps.countUnreadTotal).not.toHaveBeenCalled()
    })

    it('keeps the badge alive when the user merely turns the ICON off', () => {
      const deps = makeDeps()
      initTray(deps)
      applyTraySetting(true)
      applyTraySetting(false)
      expect(isTrayActive()).toBe(false)
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()

      scheduleUnreadRefresh()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS)
      expect(deps.countUnreadTotal).toHaveBeenCalledTimes(1)
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(3)
    })

    it('re-opens on a fresh wiring', () => {
      initTray(makeDeps())
      applyTraySetting(true)
      shutdownTray()
      const deps = makeDeps()
      initTray(deps)
      scheduleUnreadRefresh()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS)
      expect(deps.countUnreadTotal).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * The quit is two acts, not one: disarm when `before-quit` fires, destroy
   * when the drain is over (bounded at ~28s by main.ts's per-step teardown
   * deadlines). Splitting them is only safe if disarming alone
   * still carries review L1's guarantee — that is what the first test drives,
   * and it is the whole reason the icon used to be destroyed this early.
   */
  describe('quit — disarm early, destroy last', () => {
    function armedTray() {
      const deps = makeDeps()
      initTray(deps)
      applyTraySetting(true)
      return { deps, icon: trayInstances[0] }
    }

    it('ignores an unread refresh from a sync pass that finishes after the disarm', () => {
      const { deps, icon } = armedTray()
      disarmTray()
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()
      icon.setToolTip.mockClear()
      mockSetBadgeCount.mockClear()

      // A periodic sync that was already in flight commits and asks for a
      // recount, exactly as it would during the drain.
      scheduleUnreadRefresh()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 4)
      refreshUnreadNow()

      // No debounce armed, no query, and no repaint of any surface.
      expect(deps.countUnreadTotal).not.toHaveBeenCalled()
      expect(icon.setToolTip).not.toHaveBeenCalled()
      expect(mockSetBadgeCount).not.toHaveBeenCalled()
    })

    it('drops a recount that was already pending when the quit started', () => {
      const { deps } = armedTray()
      ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()
      scheduleUnreadRefresh()
      disarmTray()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 4)
      expect(deps.countUnreadTotal).not.toHaveBeenCalled()
    })

    it('keeps the icon alive through the drain and destroys it only at shutdown', () => {
      const { icon } = armedTray()
      disarmTray()
      // The whole drain budget could pass here; the icon is still the user's
      // evidence that the app is doing something.
      vi.advanceTimersByTime(28_000)
      expect(icon.destroy).not.toHaveBeenCalled()
      expect(isTrayActive()).toBe(true)

      shutdownTray()
      expect(icon.destroy).toHaveBeenCalledTimes(1)
      expect(isTrayActive()).toBe(false)
    })

    it('says it is quitting instead of leaving a stale unread tooltip', () => {
      const { icon } = armedTray()
      disarmTray()
      expect(icon.tooltip).toBe('MailCopilot — Quitting…')
      expect(labels()).toEqual(['Quitting…'])
      expect(lastMenuTemplate.current[0].enabled).toBe(false)
    })

    it('localizes the quitting state', () => {
      const deps = makeDeps({ getSettings: () => ({ language: 'ru', trayEnabled: true }) })
      initTray(deps)
      applyTraySetting(true)
      disarmTray()
      expect(trayInstances[0].tooltip).toBe('MailCopilot — Завершение работы…')
    })

    it('survives an impatient second quit and never destroys twice', () => {
      const { icon } = armedTray()
      disarmTray()
      disarmTray()
      shutdownTray()
      shutdownTray()
      expect(icon.destroy).toHaveBeenCalledTimes(1)
    })

    it('refuses to mint a new icon from a settings toggle arriving mid-drain', () => {
      const { icon } = armedTray()
      disarmTray()
      applyTraySetting(false)
      applyTraySetting(true)
      expect(trayInstances).toHaveLength(1)
      expect(icon.destroy).not.toHaveBeenCalled()
      // ...and the quitting menu was not painted over with the live one.
      expect(labels()).toEqual(['Quitting…'])
    })

    it('is a no-op with no icon at all, and still closes the gate', () => {
      const deps = makeDeps()
      initTray(deps)
      expect(() => { disarmTray(); shutdownTray() }).not.toThrow()
      scheduleUnreadRefresh()
      vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS)
      expect(deps.countUnreadTotal).not.toHaveBeenCalled()
    })

    it('does not let a failing tooltip update break the quit', () => {
      const { icon } = armedTray()
      icon.setToolTip.mockImplementationOnce(() => { throw new Error('no tray host') })
      expect(() => disarmTray()).not.toThrow()
      expect(() => shutdownTray()).not.toThrow()
      expect(icon.destroy).toHaveBeenCalledTimes(1)
    })

    /**
     * Installing the inert menu is the only non-cosmetic act in the quitting
     * state: while the drain runs, Open / Compose / Check Mail / Quit would act
     * on services that are already stopping. All four steps used to share one
     * `try`, so a throwing `getSettings()` or `setToolTip()` skipped the
     * disarm and left the LIVE menu clickable for the whole drain. The old test
     * asserted only that nothing threw, which is exactly why that was invisible
     * — so these assert the OUTCOME per failure mode.
     */
    describe('disarming the menu survives each individual failure mode', () => {
      /** The single disabled line the quitting state must put up. */
      function expectInertTemplate(template: Array<{ label?: string; enabled?: boolean }> | undefined) {
        expect(template).toHaveLength(1)
        expect(template?.[0].enabled).toBe(false)
        expect(template?.[0].label).toBeTruthy()
      }

      it('installs the inert menu when the settings lookup throws (English fallback label)', () => {
        let settingsThrow = false
        const deps = makeDeps({
          getSettings: () => {
            if (settingsThrow) throw new Error('settings store unreadable')
            return { language: 'ru', trayEnabled: true }
          },
        })
        initTray(deps)
        applyTraySetting(true)
        settingsThrow = true

        expect(() => disarmTray()).not.toThrow()

        // Disarmed, and the label degraded to English rather than the menu
        // staying armed. A settings failure costs a translation, not the gate.
        expectInertTemplate(lastMenuTemplate.current)
        expect(labels()).toEqual(['Quitting…'])
        expect(trayInstances[0].tooltip).toBe('MailCopilot — Quitting…')
      })

      it('installs the inert menu when the tooltip update throws', () => {
        const { icon } = armedTray()
        icon.setToolTip.mockImplementationOnce(() => { throw new Error('no tray host') })

        expect(() => disarmTray()).not.toThrow()

        // The tooltip is an explanation; the menu is the guarantee. Losing the
        // former may not cost the latter — which is why the menu goes first.
        expectInertTemplate(lastMenuTemplate.current)
        expect(icon.menu).toEqual({ template: lastMenuTemplate.current })
      })

      /**
       * Clicks the entries of the LIVE menu that was installed at arm time —
       * i.e. the menu the user is still looking at when the repaint failed.
       */
      function clickLiveEntries(live: Array<{ label?: string; click?: () => void }>) {
        for (const item of live.filter(i => i.click)) item.click?.()
      }

      it('still updates the tooltip and finishes the quit when the menu BUILD throws', () => {
        const { deps, icon } = armedTray()
        const live = [...lastMenuTemplate.current]
        mockBuildFromTemplate.mockImplementationOnce(() => { throw new Error('menu build failed') })

        expect(() => disarmTray()).not.toThrow()

        // Nothing can make the menu inert if the platform refuses to build one.
        // What is assertable: the attempt was the inert template, the live menu
        // was not re-installed, and the rest of the quitting state ran.
        const buildCalls = mockBuildFromTemplate.mock.calls
        expectInertTemplate(buildCalls[buildCalls.length - 1]?.[0])
        expect(icon.setContextMenu).toHaveBeenCalledTimes(1) // the live one, at arm time
        expect(icon.tooltip).toBe('MailCopilot — Quitting…')

        // ...and the entries the user can still SEE do nothing. The picture
        // failed to render; the guarantee is at the point of action.
        mockRecordEvent.mockClear()
        clickLiveEntries(live)
        expect(deps.onOpen).not.toHaveBeenCalled()
        expect(deps.onCompose).not.toHaveBeenCalled()
        expect(deps.onCheckMail).not.toHaveBeenCalled()
        expect(deps.onQuit).not.toHaveBeenCalled()
        // A refused click is not an invoked entry, so it does not land in the
        // counter that decides which entries earn their place.
        expect(mockRecordEvent).not.toHaveBeenCalledWith('tray.menu_action', expect.anything())

        expect(() => shutdownTray()).not.toThrow()
        expect(icon.destroy).toHaveBeenCalledTimes(1)
      })

      it('still updates the tooltip and finishes the quit when setContextMenu throws', () => {
        const { deps, icon } = armedTray()
        const live = [...lastMenuTemplate.current]
        icon.setContextMenu.mockImplementationOnce(() => { throw new Error('no tray host') })

        expect(() => disarmTray()).not.toThrow()

        expectInertTemplate(lastMenuTemplate.current)
        expect(icon.tooltip).toBe('MailCopilot — Quitting…')

        // The install threw, so the live menu is still the one on screen — and
        // every one of its entries has to refuse.
        mockRecordEvent.mockClear()
        clickLiveEntries(live)
        expect(deps.onOpen).not.toHaveBeenCalled()
        expect(deps.onCompose).not.toHaveBeenCalled()
        expect(deps.onCheckMail).not.toHaveBeenCalled()
        expect(deps.onQuit).not.toHaveBeenCalled()
        expect(mockRecordEvent).not.toHaveBeenCalledWith('tray.menu_action', expect.anything())

        expect(() => shutdownTray()).not.toThrow()
        expect(icon.destroy).toHaveBeenCalledTimes(1)
      })

      /**
       * The left-click gesture on Windows/Linux is a second, menu-independent
       * way into `onOpen` — it is registered on the Tray object itself and no
       * repaint touches it, so the paint-side disarm never covered it at all.
       * macOS opens the menu itself and never registers the handler, hence the
       * platform skip rather than a fake `process.platform`.
       */
      it.skipIf(process.platform === 'darwin')('refuses the left-click Open gesture once disarmed', () => {
        const { deps, icon } = armedTray()
        const click = icon.handlers.get('click')
        expect(click).toBeDefined()

        disarmTray()
        mockRecordEvent.mockClear()
        click?.()

        expect(deps.onOpen).not.toHaveBeenCalled()
        expect(mockRecordEvent).not.toHaveBeenCalledWith('tray.menu_action', expect.anything())
      })

      it('keeps the L1 gate closed through every one of those failures', () => {
        const { deps, icon } = armedTray()
        icon.setContextMenu.mockImplementationOnce(() => { throw new Error('no tray host') })
        icon.setToolTip.mockImplementationOnce(() => { throw new Error('no tray host') })
        disarmTray()
        ;(deps.countUnreadTotal as ReturnType<typeof vi.fn>).mockClear()

        scheduleUnreadRefresh()
        vi.advanceTimersByTime(UNREAD_REFRESH_DEBOUNCE_MS * 4)
        refreshUnreadNow()

        expect(deps.countUnreadTotal).not.toHaveBeenCalled()
      })
    })
  })
})
