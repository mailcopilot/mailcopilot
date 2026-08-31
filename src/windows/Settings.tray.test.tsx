// @vitest-environment jsdom
/**
 * §2.99 — TraySection wiring inside the real Settings window.
 *
 * TraySection.test.tsx (presentational) already pins the component's own
 * contract (subordination, i18n, callback shapes) in isolation. What is NOT
 * covered there is the wiring: does Settings actually load the persisted
 * trayEnabled/closeToTray/launchAtLogin values, hold them in state, and send
 * them back through settings:save? A hand-rolled mirror of that plumbing
 * would keep passing after the wiring broke — mounting the real component is
 * the only test that fails when the connection between TraySection and
 * Settings' save() payload is severed (same rationale as the AI-tab Part B
 * tests in Settings.test.tsx).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({
  sendFeedback: vi.fn(),
  captureException: vi.fn(),
}))

import Settings from './Settings'

type SettingsBlob = Record<string, unknown>

let invoke: ReturnType<typeof vi.fn>

function installApi(settings: SettingsBlob): void {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'settings:get': return settings
      case 'settings:save': return { ok: true }
      case 'accounts:list': return []
      case 'accounts:getCurrent': return null
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return []
      case 'tls:listPins': return []
      case 'rules:list': return []
      case 'aiRules:list': return []
      case 'templates:list': return []
      case 'ai:memoryRead': return ''
      default: return undefined
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(), off: vi.fn(), initialTheme: 'light', installIdHash: '', sentryEnabled: false },
  })
}

/** Mount Settings (defaults to the General tab, where TraySection lives) and wait for load. */
async function mountGeneralTab(settings: SettingsBlob): Promise<void> {
  installApi(settings)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  await screen.findByTestId('settings-tray-enabled')
}

let closeSpy: ReturnType<typeof vi.spyOn>

afterEach(() => {
  cleanup()
  closeSpy?.mockRestore()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('§2.99 Settings — tray/close-to-tray/launch-at-login load from settings:get', () => {
  it('reflects the schema defaults when the fields are absent from the persisted record', async () => {
    await mountGeneralTab({ theme: 'light' })
    expect(screen.getByTestId('settings-tray-enabled')).toBeChecked()
    expect(screen.getByTestId('settings-tray-close-to-tray')).not.toBeChecked()
    expect(screen.getByTestId('settings-tray-launch-at-login')).not.toBeChecked()
  })

  it('reflects persisted true values for all three fields', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: true, closeToTray: true, launchAtLogin: true })
    expect(screen.getByTestId('settings-tray-enabled')).toBeChecked()
    expect(screen.getByTestId('settings-tray-close-to-tray')).toBeChecked()
    expect(screen.getByTestId('settings-tray-launch-at-login')).toBeChecked()
  })

  it('reflects a persisted trayEnabled=false, which also disables close-to-tray', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: false, closeToTray: false, launchAtLogin: true })
    expect(screen.getByTestId('settings-tray-enabled')).not.toBeChecked()
    expect(screen.getByTestId('settings-tray-close-to-tray')).toBeDisabled()
    expect(screen.getByTestId('settings-tray-launch-at-login')).toBeChecked()
  })
})

describe('§2.99 Settings — tray toggles persist through settings:save', () => {
  // Save() closes the window on success; jsdom's real window.close() tears
  // the document down mid-test, so it is stubbed the same way the other
  // Settings save-path tests do it (Settings.aiDestination.test.tsx).
  beforeEach(() => {
    closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  })

  it('sends the loaded values back unchanged when Save is clicked with no edits', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: true, closeToTray: true, launchAtLogin: false })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:save', expect.objectContaining({
      trayEnabled: true,
      closeToTray: true,
      launchAtLogin: false,
    })))
  })

  it('persists a launch-at-login toggle flipped by the user', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: true, closeToTray: false, launchAtLogin: false })
    fireEvent.click(screen.getByTestId('settings-tray-launch-at-login'))
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:save', expect.objectContaining({
      launchAtLogin: true,
    })))
  })

  // REGRESSION GUARD — turning the tray off while close-to-tray was on must not
  // silently save a stale `closeToTray: true`: the icon that made it recoverable
  // is gone, and main's own gate (isTrayActive()) would refuse to honour it
  // anyway, but the persisted value should not lie about the user's intent either.
  it('turning the tray icon off does not leave a stale closeToTray=true unaddressed in the saved payload', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: true, closeToTray: true, launchAtLogin: false })
    fireEvent.click(screen.getByTestId('settings-tray-enabled'))
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:save', expect.objectContaining({
      trayEnabled: false,
    })))
    // The checkbox itself is now disabled and un-clickable, but the STATE
    // it held before the tray was turned off is exactly what a user could
    // have last set — Settings does not silently clear it out from under them.
    const payload = invoke.mock.calls.find(([channel]) => channel === 'settings:save')?.[1] as SettingsBlob
    expect(payload.closeToTray).toBe(true)
  })

  it('does not attempt to toggle close-to-tray by clicking it while disabled', async () => {
    await mountGeneralTab({ theme: 'light', trayEnabled: false, closeToTray: false, launchAtLogin: false })
    fireEvent.click(screen.getByTestId('settings-tray-close-to-tray'))
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:save', expect.objectContaining({
      closeToTray: false,
    })))
  })
})
