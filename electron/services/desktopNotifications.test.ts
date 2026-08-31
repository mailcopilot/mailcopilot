import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * §2.99 gap-fill — desktopNotifications.ts had no test file of its own
 * (mailNotifier.ts and trayLabels.ts, the two modules it composes, are
 * thoroughly covered; this is the electron boundary between them). What is
 * pinned here: the master-switch / e2e gate, the "no display server"
 * degradation, the click → onActivate wiring, and that a failure anywhere in
 * the pipeline never throws into the sync path that calls `presentNewMail`.
 */

type FakeNotificationInstance = {
  title: string
  body: string
  silent: boolean
  handlers: Map<string, () => void>
  on: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}

const {
  mockCaptureException, mockRecordEvent, mockBuildNewMailNotification,
  notificationInstances, isSupportedMock, FakeNotification, failNextConstruction,
} = vi.hoisted(() => {
  const notificationInstances: FakeNotificationInstance[] = []
  const isSupportedMock = vi.fn(() => true)
  /**
   * Arms ONE construction failure — how a platform notification stack rejects
   * a payload (security review LOW-2 exercises the sanitisation of that error).
   */
  const failNextConstruction: { current: (() => never) | null } = { current: null }
  class FakeNotification {
    title: string
    body: string
    silent: boolean
    handlers = new Map<string, () => void>()
    on = vi.fn((event: string, handler: () => void) => { this.handlers.set(event, handler) })
    show = vi.fn()
    static isSupported = isSupportedMock
    constructor(opts: { title: string; body: string; silent: boolean }) {
      if (failNextConstruction.current) {
        const fail = failNextConstruction.current
        failNextConstruction.current = null
        fail()
      }
      this.title = opts.title
      this.body = opts.body
      this.silent = opts.silent
      notificationInstances.push(this as unknown as FakeNotificationInstance)
    }
  }
  return {
    mockCaptureException: vi.fn(),
    mockRecordEvent: vi.fn(),
    mockBuildNewMailNotification: vi.fn((input: { subject?: string | null; from?: string | null }) => ({
      title: input.subject || 'New mail',
      body: input.from || '',
    })),
    notificationInstances,
    isSupportedMock,
    FakeNotification,
    failNextConstruction,
  }
})

vi.mock('electron', () => ({ Notification: FakeNotification }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mockCaptureException }))
vi.mock('../metrics', () => ({ recordEvent: mockRecordEvent }))
vi.mock('../trayLabels', () => ({
  buildNewMailNotification: mockBuildNewMailNotification,
  trayLabels: () => ({
    backgroundHintTitle: 'MailCopilot is still running',
    backgroundHintBody: 'The window was closed to the tray.',
  }),
}))

import {
  initDesktopNotifications, presentNewMail, presentBackgroundHint,
  type MailRef, type DesktopNotificationDeps,
} from './desktopNotifications'
import type { NewMailNotification } from './mailNotifier'

function makePayload(overrides: Partial<NewMailNotification> = {}): NewMailNotification {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid: 42,
    count: 1,
    subject: 'Invoice',
    from: 'Ann',
    lang: 'en',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<DesktopNotificationDeps> = {}): DesktopNotificationDeps {
  return {
    onActivate: vi.fn(),
    isEnabled: () => true,
    // Review M2 — default to "the user is elsewhere", which is when a toast is
    // the point. Focused-window suppression has its own cases below.
    isAppFocused: () => false,
    ...overrides,
  }
}

describe('desktopNotifications — before wiring', () => {
  it('does nothing when presentNewMail is called before initDesktopNotifications', async () => {
    vi.resetModules()
    notificationInstances.length = 0
    const fresh = await import('./desktopNotifications')
    expect(() => fresh.presentNewMail(makePayload())).not.toThrow()
    expect(notificationInstances).toHaveLength(0)
  })
})

describe('desktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationInstances.length = 0
    isSupportedMock.mockReturnValue(true)
  })

  it('shows nothing when the master switch (or e2e) disables notifications', () => {
    initDesktopNotifications(makeDeps({ isEnabled: () => false }))
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(0)
    expect(mockRecordEvent).not.toHaveBeenCalled()
  })

  it('shows nothing and logs, not throws, when the OS reports no notification support', () => {
    isSupportedMock.mockReturnValue(false)
    initDesktopNotifications(makeDeps())
    expect(() => presentNewMail(makePayload())).not.toThrow()
    expect(notificationInstances).toHaveLength(0)
    expect(mockRecordEvent).not.toHaveBeenCalled()
  })

  it('builds the notification from the localized labels and shows it', () => {
    initDesktopNotifications(makeDeps())
    presentNewMail(makePayload({ subject: 'Invoice #42', from: 'Ann', lang: 'de' }))

    expect(mockBuildNewMailNotification).toHaveBeenCalledWith({
      lang: 'de', count: 1, subject: 'Invoice #42', from: 'Ann',
    })
    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0].title).toBe('Invoice #42')
    expect(notificationInstances[0].body).toBe('Ann')
    expect(notificationInstances[0].show).toHaveBeenCalledTimes(1)
  })

  it('records a shown-toast event with a batched flag but no mail content', () => {
    initDesktopNotifications(makeDeps())
    presentNewMail(makePayload({ count: 1 }))
    expect(mockRecordEvent).toHaveBeenCalledWith('notification.shown', { batched: false })

    presentNewMail(makePayload({ count: 5 }))
    expect(mockRecordEvent).toHaveBeenLastCalledWith('notification.shown', { batched: true })

    for (const call of mockRecordEvent.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Invoice')
      expect(JSON.stringify(call)).not.toContain('Ann')
    }
  })

  it('routes a click to onActivate with identifiers only, and records the click', () => {
    const onActivate = vi.fn()
    initDesktopNotifications(makeDeps({ onActivate }))
    presentNewMail(makePayload({ accountId: 7, folder: 'Work', uid: 99 }))

    const click = notificationInstances[0].handlers.get('click')
    expect(click).toBeTypeOf('function')
    click?.()

    expect(onActivate).toHaveBeenCalledWith({ accountId: 7, folder: 'Work', uid: 99 } satisfies MailRef)
    expect(mockRecordEvent).toHaveBeenCalledWith('notification.clicked', {})
  })

  it('reports (but does not throw from) an onActivate that fails', () => {
    const onActivate = vi.fn(() => { throw new Error('renderer window gone') })
    initDesktopNotifications(makeDeps({ onActivate }))
    presentNewMail(makePayload())

    const click = notificationInstances[0].handlers.get('click')
    expect(() => click?.()).not.toThrow()
    // Security review LOW-2: a synthetic error plus a bounded code, never the
    // raw one (the detailed sanitisation cases live at the end of this file).
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'notifications:activate' }),
    )
  })

  it('never throws when building/showing the notification itself fails', () => {
    initDesktopNotifications(makeDeps())
    mockBuildNewMailNotification.mockImplementationOnce(() => { throw new Error('bad labels') })
    expect(() => presentNewMail(makePayload())).not.toThrow()
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'notifications:present' }),
    )
  })
})

describe('desktopNotifications — review M2: foreground suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationInstances.length = 0
  })

  it('shows nothing while the user is looking at the app', () => {
    initDesktopNotifications(makeDeps({ isAppFocused: () => true }))
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(0)
    expect(mockRecordEvent).toHaveBeenCalledWith('notification.suppressed', { reason: 'app_focused' })
    expect(mockRecordEvent).not.toHaveBeenCalledWith('notification.shown', expect.anything())
  })

  it('shows the toast as soon as the app is not focused', () => {
    initDesktopNotifications(makeDeps({ isAppFocused: () => false }))
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(1)
    expect(mockRecordEvent).toHaveBeenCalledWith('notification.shown', { batched: false })
  })

  it('checks focus per notification, not once at wiring time', () => {
    let focused = true
    initDesktopNotifications(makeDeps({ isAppFocused: () => focused }))
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(0)
    focused = false
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(1)
  })

  it('still shows nothing when the switch is off, whatever the focus says', () => {
    initDesktopNotifications(makeDeps({ isEnabled: () => false, isAppFocused: () => false }))
    presentNewMail(makePayload())
    expect(notificationInstances).toHaveLength(0)
    expect(mockRecordEvent).not.toHaveBeenCalledWith('notification.suppressed', expect.anything())
  })
})

describe('security review LOW-2 — a failing OS notification reports no mail content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationInstances.length = 0
    failNextConstruction.current = null
  })

  const SECRET = 'Payroll 2026 for alice@example.test'

  it('sends a synthetic error to Sentry when the platform quotes the payload back', () => {
    failNextConstruction.current = () => { throw new Error(`notification rejected: title="${SECRET}"`) }
    initDesktopNotifications(makeDeps())
    expect(() => presentNewMail(makePayload({ subject: SECRET }))).not.toThrow()

    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [err, ctx] = mockCaptureException.mock.calls[0]
    expect((err as Error).message).toBe('notification present failed')
    expect(JSON.stringify(ctx)).not.toContain('Payroll')
    expect(JSON.stringify(ctx)).not.toContain('alice@example.test')
    expect(ctx).toMatchObject({ source: 'notifications:present' })
  })

  it('keeps a code-shaped platform code and collapses anything else', () => {
    failNextConstruction.current = () => {
      const err = new Error(SECRET) as Error & { code?: string }
      err.code = 'ENOTIFY_UNAVAILABLE'
      throw err
    }
    initDesktopNotifications(makeDeps())
    presentNewMail(makePayload())
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({ code: 'ENOTIFY_UNAVAILABLE' })

    vi.clearAllMocks()
    failNextConstruction.current = () => {
      const err = new Error(SECRET) as Error & { code?: string }
      err.code = `weird ${SECRET}`
      throw err
    }
    presentNewMail(makePayload())
    const ctx = mockCaptureException.mock.calls[0][1] as Record<string, unknown>
    expect(ctx.code).toBe('Error') // falls back to the class name, never the text
    expect(JSON.stringify(ctx)).not.toContain('Payroll')
  })

  it('sanitises the activation failure the same way', () => {
    const onActivate = vi.fn(() => { throw new Error(SECRET) })
    initDesktopNotifications(makeDeps({ onActivate }))
    presentNewMail(makePayload({ subject: SECRET }))
    notificationInstances[0].handlers.get('click')?.()

    const [err, ctx] = mockCaptureException.mock.calls[0]
    expect((err as Error).message).toBe('notification activation failed')
    expect(JSON.stringify(ctx)).not.toContain('Payroll')
    expect(ctx).toMatchObject({ source: 'notifications:activate' })
  })
})

/**
 * §2.228 — the one-shot "the window went to the tray" hint. The once-per-
 * session latch belongs to backgroundMail.ts (pinned there); what is pinned
 * here is the electron boundary: silent, content-free, subject to the user's
 * notifications switch, and never able to throw into the close path.
 */
describe('desktopNotifications — background hint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notificationInstances.length = 0
    isSupportedMock.mockReturnValue(true)
  })

  it('shows a silent, mail-free hint', () => {
    initDesktopNotifications(makeDeps())
    presentBackgroundHint('en')
    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0].silent).toBe(true)
    expect(notificationInstances[0].title).toBe('MailCopilot is still running')
    expect(mockRecordEvent).not.toHaveBeenCalled()
  })

  it('respects the notifications switch and an OS with no notification support', () => {
    initDesktopNotifications(makeDeps({ isEnabled: () => false }))
    presentBackgroundHint('en')
    expect(notificationInstances).toHaveLength(0)

    initDesktopNotifications(makeDeps())
    isSupportedMock.mockReturnValue(false)
    presentBackgroundHint('en')
    expect(notificationInstances).toHaveLength(0)
  })

  it('is shown even while the app is focused — it is about the window, not about mail', () => {
    initDesktopNotifications(makeDeps({ isAppFocused: () => true }))
    presentBackgroundHint('en')
    expect(notificationInstances).toHaveLength(1)
  })

  it('never throws into the close path when the platform rejects it', () => {
    initDesktopNotifications(makeDeps())
    failNextConstruction.current = () => { throw new Error('no session bus') }
    expect(() => presentBackgroundHint('en')).not.toThrow()
    expect(notificationInstances).toHaveLength(0)
  })
})
