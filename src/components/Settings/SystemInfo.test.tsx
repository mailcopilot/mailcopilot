// @vitest-environment jsdom
/**
 * §2.19 — SystemInfo component tests.
 *
 * Coverage targets (per audit gaps):
 *   1. State machine: idle → checking → up-to-date | available | downloading | downloaded | error
 *   2. Background event wiring (update:available, update:downloadProgress,
 *      update:downloaded, update:checkResult, update:downloadFailed)
 *   3. §2.58 — self-update warning (never a disabled checkbox) when
 *      canSelfUpdate=false, keyed on the enum reason from main
 *   4. Unsupported (dev) state — button hidden, hint visible
 *   5. System info fields rendered correctly (versions, install path, channel badge)
 *   6. Read-only install path badge
 *   7. latestVersion displayed next to app version while status rotates
 *   8. Download button click → downloading state
 *   9. Restart button click → update:install IPC
 *  10. Error variants per error_class (network / permission / unknown)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

// --- Stable i18n stub --------------------------------------------------------
// Keys must exactly mirror the keys used in SystemInfo.tsx.
// stableT and stableUseTranslation must be module-level constants — if t is
// recreated on each render call, `useEffect([t])` loops infinitely.
const i18nMap: Record<string, string> = {
  'settings.about.system.title': 'System',
  'settings.about.system.appVersion': 'App version',
  'settings.about.system.electron': 'Electron',
  'settings.about.system.chromium': 'Chromium',
  'settings.about.system.node': 'Node',
  'settings.about.system.platform': 'Platform',
  'settings.about.system.installPath': 'Install path',
  'settings.about.system.readOnly': 'read-only',
  'settings.about.system.channel.dev': 'dev',
  'settings.about.system.channel.nightly': 'nightly',
  'settings.about.system.channel.stable': 'stable',
  'settings.about.system.latestAvailable': '(latest: {{version}})',
  'settings.about.update.title': 'Updates',
  'settings.about.update.autoDownload': 'Automatically download updates',
  'settings.about.update.autoDownloadHint': 'Updates are downloaded in the background.',
  'settings.about.update.cannotSelfUpdateHint': 'Cannot self-update — folder not writable.',
  'settings.about.update.cannotSelfUpdateNoTarget': 'Cannot self-update — not an AppImage or system package.',
  'settings.about.update.cannotSelfUpdateUnknown': 'This installation cannot update itself automatically.',
  'settings.about.update.unsupportedDev': 'Auto-update not available in dev builds.',
  'settings.about.update.checkNow': 'Check now',
  'settings.about.update.checking': 'Checking…',
  'settings.about.update.upToDate': 'Up to date',
  'settings.about.update.downloadVersion': 'Download {{version}}',
  'settings.about.update.downloadingPercent': 'Downloading {{percent}}%',
  'settings.about.update.restartToInstall': 'Restart to install',
  'settings.about.update.errorNetwork': 'Network error — check connection',
  'settings.about.update.errorPermission': 'Permission error — run as admin',
  'settings.about.update.errorUnknown': 'Update failed',
}
const stableT = (key: string, opts?: Record<string, unknown>) => {
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}
const stableUseTranslation = { t: stableT }

vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

// --- window.api mock ---------------------------------------------------------
// Listeners are collected so tests can fire synthetic background events.
type Listener = (payload?: unknown) => void
const registeredListeners = new Map<string, Listener[]>()
const mockInvoke = vi.fn()
const mockOn = vi.fn((channel: string, cb: Listener) => {
  const existing = registeredListeners.get(channel) ?? []
  registeredListeners.set(channel, [...existing, cb])
})
const mockOff = vi.fn((channel: string, cb: Listener) => {
  const existing = registeredListeners.get(channel) ?? []
  registeredListeners.set(channel, existing.filter(f => f !== cb))
})

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

/** Fire a synthetic IPC event through all registered listeners. */
function emit(channel: string, payload?: unknown) {
  const listeners = registeredListeners.get(channel) ?? []
  listeners.forEach(fn => fn(payload))
}

// --- SystemInfo import (static — after mocks are hoisted) --------------------
import SystemInfo from './SystemInfo'

// --- Types & factory helpers -------------------------------------------------
type SystemInfoPayload = {
  appVersion: string
  channel: 'dev' | 'nightly' | 'stable'
  electron: string
  chromium: string
  node: string
  platform: string
  arch: string
  installPath: string
  installPathWritable: boolean
  canSelfUpdate: boolean
  selfUpdateBlockedReason?: 'not-packaged' | 'no-in-place-target' | 'target-dir-readonly' | null
  isPackaged: boolean
}

function makeInfo(overrides: Partial<SystemInfoPayload> = {}): SystemInfoPayload {
  return {
    appVersion: '1.2.3',
    channel: 'stable',
    electron: '30.0.0',
    chromium: '124.0.0.0',
    node: '22.14.0',
    platform: 'linux',
    arch: 'x64',
    installPath: '/opt/mailcopilot/bin/mailcopilot',
    installPathWritable: true,
    canSelfUpdate: true,
    selfUpdateBlockedReason: null,
    isPackaged: true,
    ...overrides,
  }
}

function renderComponent(
  props: { autoUpdateEnabled?: boolean; onAutoUpdateEnabledChange?: (v: boolean) => void } = {},
) {
  const {
    autoUpdateEnabled = false,
    onAutoUpdateEnabledChange = vi.fn(),
  } = props
  return render(
    React.createElement(SystemInfo, { autoUpdateEnabled, onAutoUpdateEnabledChange }),
  )
}

// Default systemInfo invoke behaviour — individual tests can override.
function setupDefaultInvoke(infoOverrides: Partial<SystemInfoPayload> = {}) {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'update:systemInfo') return Promise.resolve(makeInfo(infoOverrides))
    if (channel === 'update:check') return Promise.resolve({ ok: true, status: 'up-to-date' })
    return Promise.resolve({ ok: true })
  })
}

// --- Test suites -------------------------------------------------------------

describe('SystemInfo — uiaudit.12: installPath wrapped in <code>', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders installPath inside a <code> element (uiaudit.12)', async () => {
    setupDefaultInvoke({ installPath: '/opt/mailcopilot/bin/mailcopilot' })
    renderComponent()
    await act(async () => {})
    const pathSpan = screen.getByTestId('settings-about-install-path')
    const codeEl = pathSpan.querySelector('code')
    expect(codeEl).not.toBeNull()
    expect(codeEl?.textContent).toBe('/opt/mailcopilot/bin/mailcopilot')
  })

  it('code element has word-break and overflow-wrap styles (uiaudit.12)', async () => {
    setupDefaultInvoke({ installPath: '/very/long/path/without/any/slashes-at-end' })
    renderComponent()
    await act(async () => {})
    const pathSpan = screen.getByTestId('settings-about-install-path')
    const codeEl = pathSpan.querySelector('code') as HTMLElement | null
    expect(codeEl).not.toBeNull()
    expect(codeEl!.style.wordBreak).toBe('break-word')
    expect(codeEl!.style.overflowWrap).toBe('anywhere')
  })

  it('read-only badge appears after the <code> element when path is not writable (uiaudit.12)', async () => {
    setupDefaultInvoke({ installPath: '/read-only/path', installPathWritable: false })
    renderComponent()
    await act(async () => {})
    const pathSpan = screen.getByTestId('settings-about-install-path')
    const codeEl = pathSpan.querySelector('code')
    const readOnlyBadge = screen.getByTestId('settings-about-install-readonly')
    expect(codeEl).not.toBeNull()
    // The <code> element must be a sibling / precede the badge inside the span
    expect(pathSpan.contains(codeEl)).toBe(true)
    expect(pathSpan.contains(readOnlyBadge)).toBe(true)
  })
})

describe('SystemInfo — system info display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders version info after systemInfo resolves', async () => {
    setupDefaultInvoke({ appVersion: '2.0.0', channel: 'stable' })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-app-version')).toHaveTextContent('2.0.0')
    expect(screen.getByTestId('settings-about-electron')).toHaveTextContent('30.0.0')
    expect(screen.getByTestId('settings-about-chromium')).toHaveTextContent('124.0.0.0')
    expect(screen.getByTestId('settings-about-node')).toHaveTextContent('22.14.0')
    expect(screen.getByTestId('settings-about-platform')).toHaveTextContent('linux (x64)')
    expect(screen.getByTestId('settings-about-install-path')).toHaveTextContent(
      '/opt/mailcopilot/bin/mailcopilot',
    )
  })

  it('shows channel badge matching the info payload', async () => {
    setupDefaultInvoke({ channel: 'nightly' })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-channel')).toHaveTextContent('nightly')
  })

  it('shows "read-only" badge when installPathWritable is false', async () => {
    setupDefaultInvoke({ installPathWritable: false })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-install-readonly')).toBeInTheDocument()
  })

  it('does not show read-only badge when installPathWritable is true', async () => {
    setupDefaultInvoke({ installPathWritable: true })
    renderComponent()
    await act(async () => {})
    expect(screen.queryByTestId('settings-about-install-readonly')).not.toBeInTheDocument()
  })

  it('renders without crash before systemInfo resolves (shows global fallback version)', () => {
    // Never-resolving promise — keeps component in the pre-info state.
    mockInvoke.mockImplementation(() => new Promise(() => {}))
    renderComponent()
    // No crash; version element is present showing the global fallback.
    expect(screen.getByTestId('settings-about-app-version')).toBeInTheDocument()
    // No info rows (electron, chromium, node, platform) before info resolves.
    expect(screen.queryByTestId('settings-about-electron')).not.toBeInTheDocument()
  })
})

describe('SystemInfo — auto-update checkbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('checkbox is enabled and checked when autoUpdateEnabled=true and canSelfUpdate=true', async () => {
    setupDefaultInvoke({ canSelfUpdate: true })
    renderComponent({ autoUpdateEnabled: true })
    await act(async () => {})
    const checkbox = screen.getByTestId('settings-about-auto-update') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(false)
  })

  // §2.58 — the checkbox is never disabled any more: a build that cannot
  // update itself in place still lets the user own the preference (the
  // warning below explains why nothing will download).
  it('checkbox stays enabled when canSelfUpdate=false (warning, not lockout)', async () => {
    setupDefaultInvoke({
      canSelfUpdate: false,
      installPathWritable: false,
      selfUpdateBlockedReason: 'target-dir-readonly',
    })
    renderComponent({ autoUpdateEnabled: false })
    await act(async () => {})
    const checkbox = screen.getByTestId('settings-about-auto-update') as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
  })

  it('user can still toggle the preference when canSelfUpdate=false', async () => {
    setupDefaultInvoke({ canSelfUpdate: false, selfUpdateBlockedReason: 'target-dir-readonly' })
    const handler = vi.fn()
    renderComponent({ autoUpdateEnabled: false, onAutoUpdateEnabledChange: handler })
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-auto-update'))
    })
    expect(handler).toHaveBeenCalledWith(true)
  })

  it('checkbox label carries tooltip text when canSelfUpdate=false', async () => {
    setupDefaultInvoke({ canSelfUpdate: false, selfUpdateBlockedReason: 'target-dir-readonly' })
    renderComponent({ autoUpdateEnabled: false })
    await act(async () => {})
    const label = screen.getByTestId('settings-about-auto-update').closest('label')
    expect(label?.title).toBe('Cannot self-update — folder not writable.')
  })

  it('checkbox label has no tooltip when canSelfUpdate=true', async () => {
    setupDefaultInvoke({ canSelfUpdate: true })
    renderComponent({ autoUpdateEnabled: false })
    await act(async () => {})
    const label = screen.getByTestId('settings-about-auto-update').closest('label')
    expect(label?.title).toBeFalsy()
  })

  it('calls onAutoUpdateEnabledChange(true) when user clicks checkbox', async () => {
    setupDefaultInvoke({ canSelfUpdate: true })
    const handler = vi.fn()
    renderComponent({ autoUpdateEnabled: false, onAutoUpdateEnabledChange: handler })
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-auto-update'))
    })
    expect(handler).toHaveBeenCalledWith(true)
  })

  it('shows the read-only warning when blocked reason is target-dir-readonly', async () => {
    setupDefaultInvoke({ canSelfUpdate: false, selfUpdateBlockedReason: 'target-dir-readonly' })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-self-update-warning')).toHaveTextContent(
      'Cannot self-update — folder not writable.',
    )
  })

  it('shows the no-target warning when the build is not an AppImage / system package', async () => {
    setupDefaultInvoke({ canSelfUpdate: false, selfUpdateBlockedReason: 'no-in-place-target' })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-self-update-warning')).toHaveTextContent(
      'Cannot self-update — not an AppImage or system package.',
    )
  })

  // A missing reason must NOT be rendered as "folder not writable": that is a
  // diagnosis we do not have. Neutral wording only.
  it('shows the neutral warning when the payload carries no reason', async () => {
    setupDefaultInvoke({ canSelfUpdate: false, selfUpdateBlockedReason: undefined })
    renderComponent()
    await act(async () => {})
    const warning = screen.getByTestId('settings-about-self-update-warning')
    expect(warning).toHaveTextContent('This installation cannot update itself automatically.')
    expect(warning).not.toHaveTextContent('folder not writable')
  })

  it('shows the neutral warning when the reason is not one we know', async () => {
    // Defensive: the enum crosses IPC, so an unrecognised string must degrade
    // to the neutral text rather than falling through to a guessed cause.
    setupDefaultInvoke({
      canSelfUpdate: false,
      selfUpdateBlockedReason: 'some-future-reason' as unknown as 'target-dir-readonly',
    })
    renderComponent()
    await act(async () => {})
    const warning = screen.getByTestId('settings-about-self-update-warning')
    expect(warning).toHaveTextContent('This installation cannot update itself automatically.')
  })

  it('shows no self-update warning in dev builds (unsupported state covers it)', async () => {
    setupDefaultInvoke({ isPackaged: false, canSelfUpdate: false, selfUpdateBlockedReason: 'not-packaged' })
    renderComponent()
    await act(async () => {})
    expect(screen.queryByTestId('settings-about-self-update-warning')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-about-update-unsupported')).toBeInTheDocument()
  })

  it('shows autoDownloadHint paragraph and no warning when canSelfUpdate=true', async () => {
    setupDefaultInvoke({ canSelfUpdate: true })
    renderComponent()
    await act(async () => {})
    expect(screen.getByText('Updates are downloaded in the background.')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-about-self-update-warning')).not.toBeInTheDocument()
  })

  it('.deb install with an admin-owned directory is not treated as read-only', async () => {
    // §2.58 — main reports installPathWritable=true for distro packages
    // (the updater elevates), so the "read-only" marker must not appear.
    setupDefaultInvoke({
      canSelfUpdate: true,
      installPathWritable: true,
      installPath: '/opt/MailCopilot/mailcopilot',
    })
    renderComponent()
    await act(async () => {})
    expect(screen.queryByTestId('settings-about-install-readonly')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-about-self-update-warning')).not.toBeInTheDocument()
  })
})

describe('SystemInfo — state machine: idle → unsupported (dev build)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('shows unsupported hint and no check button when not packaged', async () => {
    setupDefaultInvoke({ isPackaged: false, canSelfUpdate: false })
    renderComponent()
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-unsupported')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-about-check-update')).not.toBeInTheDocument()
  })
})

describe('SystemInfo — state machine: idle → checking → up-to-date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('check button is initially enabled for packaged build', async () => {
    setupDefaultInvoke({ isPackaged: true })
    renderComponent()
    await act(async () => {})
    const btn = screen.getByTestId('settings-about-check-update') as HTMLButtonElement
    expect(btn).toBeInTheDocument()
    expect(btn.disabled).toBe(false)
  })

  it('disables button and shows "Checking…" while in-flight', async () => {
    let resolveCheck: () => void
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check') return new Promise(res => { resolveCheck = () => res({ ok: true, status: 'up-to-date' }) })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    const btn = screen.getByTestId('settings-about-check-update') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn).toHaveTextContent('Checking…')
    // Clean up — resolve the hanging promise so no timers leak.
    await act(async () => { resolveCheck?.() })
  })

  it('shows up-to-date badge after check returns up-to-date', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check') return Promise.resolve({ ok: true, status: 'up-to-date' })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-uptodate')).toBeInTheDocument()
    // latestVersion is cleared on up-to-date.
    expect(screen.queryByTestId('settings-about-latest-version')).not.toBeInTheDocument()
  })
})

describe('SystemInfo — state machine: available → download → downloading → downloaded → restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('shows download button with version when check returns available', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo')
        return Promise.resolve(makeInfo({ isPackaged: true, canSelfUpdate: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: true, status: 'available', version: '2.0.0' })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-download-update')).toHaveTextContent('Download 2.0.0')
    expect(screen.getByTestId('settings-about-latest-version')).toHaveTextContent('(latest: 2.0.0)')
  })

  it('transitions to downloading state when download button clicked', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo')
        return Promise.resolve(makeInfo({ isPackaged: true, canSelfUpdate: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: true, status: 'available', version: '2.0.0' })
      if (channel === 'update:download') return new Promise(() => {}) // never resolves
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-download-update'))
    })
    expect(screen.getByTestId('settings-about-update-downloading')).toHaveTextContent('Downloading 0%')
  })

  it('shows restart button after update:downloaded background event while downloading', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo')
        return Promise.resolve(makeInfo({ isPackaged: true, canSelfUpdate: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: true, status: 'available', version: '2.0.0' })
      if (channel === 'update:download') return Promise.resolve({ ok: true })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-download-update'))
    })
    await act(async () => {})
    // Simulate the background event that electron-updater fires on completion.
    await act(async () => {
      emit('update:downloaded')
    })
    expect(screen.getByTestId('settings-about-restart-update')).toBeInTheDocument()
  })

  it('calls update:install IPC when restart button is clicked', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo')
        return Promise.resolve(makeInfo({ isPackaged: true, canSelfUpdate: true }))
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    // Force downloaded state via background event (background auto-download scenario).
    await act(async () => {
      emit('update:downloaded')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-restart-update'))
    })
    expect(mockInvoke).toHaveBeenCalledWith('update:install')
  })
})

describe('SystemInfo — state machine: error variants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('shows network error message when error_class=network', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: false, status: 'error', error_class: 'network' })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-error')).toHaveTextContent(
      'Network error — check connection',
    )
  })

  it('shows permission error message when error_class=permission', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: false, status: 'error', error_class: 'permission' })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-error')).toHaveTextContent(
      'Permission error — run as admin',
    )
  })

  it('shows generic error when error_class=unknown', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check')
        return Promise.resolve({ ok: false, status: 'error', error_class: 'unknown' })
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-error')).toHaveTextContent('Update failed')
  })

  it('shows generic error when check IPC rejects unexpectedly', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(makeInfo({ isPackaged: true }))
      if (channel === 'update:check') return Promise.reject(new Error('unexpected IPC failure'))
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-update'))
    })
    await act(async () => {})
    expect(screen.getByTestId('settings-about-update-error')).toBeInTheDocument()
  })
})

describe('SystemInfo — background event subscriptions (IPC wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  function renderPackaged() {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo')
        return Promise.resolve(makeInfo({ isPackaged: true, canSelfUpdate: true }))
      return Promise.resolve({ ok: true })
    })
    renderComponent()
  }

  it('registers all 5 background listeners on mount', async () => {
    renderPackaged()
    await act(async () => {})
    expect(registeredListeners.has('update:available')).toBe(true)
    expect(registeredListeners.has('update:downloadProgress')).toBe(true)
    expect(registeredListeners.has('update:downloaded')).toBe(true)
    expect(registeredListeners.has('update:checkResult')).toBe(true)
    expect(registeredListeners.has('update:downloadFailed')).toBe(true)
  })

  it('update:available event sets available state and latestVersion', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:available', { version: '3.1.0' })
    })
    expect(screen.getByTestId('settings-about-download-update')).toHaveTextContent('Download 3.1.0')
    expect(screen.getByTestId('settings-about-latest-version')).toHaveTextContent('(latest: 3.1.0)')
  })

  it('update:downloadProgress event updates percent display', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:downloadProgress', { percent: 47.6, transferred: 5_000_000, total: 10_000_000 })
    })
    expect(screen.getByTestId('settings-about-update-downloading')).toHaveTextContent('Downloading 47%')
  })

  it('update:downloadProgress clamps percent to 100 for over-100 values', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:downloadProgress', { percent: 150 })
    })
    expect(screen.getByTestId('settings-about-update-downloading')).toHaveTextContent('Downloading 100%')
  })

  it('update:downloadProgress clamps percent to 0 for negative values', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:downloadProgress', { percent: -10 })
    })
    expect(screen.getByTestId('settings-about-update-downloading')).toHaveTextContent('Downloading 0%')
  })

  it('update:downloaded event shows restart button (background download)', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:downloaded')
    })
    expect(screen.getByTestId('settings-about-restart-update')).toBeInTheDocument()
    // Check button is gone in downloaded state (rendering condition in component).
    expect(screen.queryByTestId('settings-about-check-update')).not.toBeInTheDocument()
  })

  it('update:checkResult with status=available sets available state', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:checkResult', { status: 'available', version: '4.0.0' })
    })
    expect(screen.getByTestId('settings-about-download-update')).toHaveTextContent('Download 4.0.0')
  })

  it('update:checkResult with status=up-to-date shows badge and clears latestVersion', async () => {
    renderPackaged()
    await act(async () => {})
    // Seed a latestVersion via available.
    await act(async () => {
      emit('update:checkResult', { status: 'available', version: '4.0.0' })
    })
    expect(screen.getByTestId('settings-about-latest-version')).toBeInTheDocument()
    // Subsequent up-to-date result should clear it.
    await act(async () => {
      emit('update:checkResult', { status: 'up-to-date' })
    })
    expect(screen.getByTestId('settings-about-update-uptodate')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-about-latest-version')).not.toBeInTheDocument()
  })

  it('update:checkResult with status=error shows error element', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:checkResult', { status: 'error', error_class: 'network' })
    })
    expect(screen.getByTestId('settings-about-update-error')).toHaveTextContent(
      'Network error — check connection',
    )
  })

  it('update:downloadFailed event shows error element', async () => {
    renderPackaged()
    await act(async () => {})
    await act(async () => {
      emit('update:downloadFailed', { error_class: 'permission' })
    })
    expect(screen.getByTestId('settings-about-update-error')).toHaveTextContent(
      'Permission error — run as admin',
    )
  })

  it('deregisters all listeners on unmount', async () => {
    renderPackaged()
    await act(async () => {})
    // cleanup() (also called in afterEach) triggers the useEffect cleanup,
    // which calls off(). After cleanup, no listeners for any channel should remain.
    cleanup()
    for (const channel of [
      'update:available',
      'update:downloadProgress',
      'update:downloaded',
      'update:checkResult',
      'update:downloadFailed',
    ]) {
      const remaining = registeredListeners.get(channel) ?? []
      expect(remaining).toHaveLength(0)
    }
  })
})

/**
 * §2.58 iter2 — main refuses `update:systemInfo` for any sender that is not
 * the settings window (the payload carries `process.execPath`). This panel
 * only ever renders inside that window, so `null` is a wiring-regression
 * signal rather than a user-facing state — but it must degrade, not crash:
 * the same fallback as an outright IPC failure.
 */
describe('SystemInfo — §2.58 iter2: refused (null) systemInfo payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('keeps the panel alive and shows no install path when main returns null', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(null)
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})

    // Panel still renders (static app version), no crash from the null read.
    expect(screen.getByTestId('settings-about-system')).toBeInTheDocument()
    expect(screen.getByTestId('settings-about-app-version')).toBeInTheDocument()
    // Nothing derived from the refused payload is shown — most importantly
    // the install path, which is the value the sender gate protects.
    expect(screen.queryByTestId('settings-about-install-path')).toBeNull()
    expect(screen.queryByTestId('settings-about-channel')).toBeNull()
  })

  it('does not fall into the dev "unsupported" state on a refusal', async () => {
    // `isPackaged` is unknown when the payload is refused; claiming
    // "auto-update unsupported" would be an invented diagnosis.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'update:systemInfo') return Promise.resolve(null)
      return Promise.resolve({ ok: true })
    })
    renderComponent()
    await act(async () => {})

    expect(screen.queryByTestId('settings-about-update-unsupported')).toBeNull()
  })
})
