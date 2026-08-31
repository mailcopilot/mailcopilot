// @vitest-environment jsdom
/**
 * Component tests for src/components/Settings/TraySection.tsx — §2.99.
 *
 * What each test protects:
 *   - the three toggles reflect the persisted values and report changes back,
 *     since Settings owns the state and this component is presentational;
 *   - close-to-tray is subordinate to the tray icon: with the tray off it is
 *     not operable, because closing into an icon that is not drawn would hide
 *     the window with no way to get it back;
 *   - the Linux no-tray note is always present — that behaviour is not
 *     discoverable, so it must be stated rather than learned by losing a window;
 *   - every visible string comes from i18n, never a literal.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import en from '../../i18n/locales/en.json'
import TraySection, { type LaunchAtLoginStatus } from './TraySection'

// The shipped English wording, so the assertions pin the real strings and fail
// if a key is renamed or dropped from en.json.
const LABELS = {
  enabled: en.settings.tray.enabled,
  closeToTray: en.settings.tray.closeToTray,
  launchAtLogin: en.settings.tray.launchAtLogin,
  note: en.settings.tray.linuxNoTrayNote,
  unsupported: en.settings.tray.launchAtLoginUnsupported,
  failed: en.settings.tray.launchAtLoginFailed,
  disableFailed: en.settings.tray.launchAtLoginDisableFailed,
}

const i18nMap: Record<string, string> = {
  'settings.tray.enabled': LABELS.enabled,
  'settings.tray.closeToTray': LABELS.closeToTray,
  'settings.tray.launchAtLogin': LABELS.launchAtLogin,
  'settings.tray.linuxNoTrayNote': LABELS.note,
  'settings.tray.launchAtLoginUnsupported': LABELS.unsupported,
  'settings.tray.launchAtLoginFailed': LABELS.failed,
  'settings.tray.launchAtLoginDisableFailed': LABELS.disableFailed,
}
const stableT = (key: string): string => i18nMap[key] ?? key
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }))

type Handlers = {
  onTrayEnabledChange: ReturnType<typeof vi.fn>
  onCloseToTrayChange: ReturnType<typeof vi.fn>
  onLaunchAtLoginChange: ReturnType<typeof vi.fn>
}

type Overrides = Partial<{
  trayEnabled: boolean
  closeToTray: boolean
  launchAtLogin: boolean
  launchAtLoginStatus: LaunchAtLoginStatus
}>

function renderSection(overrides: Overrides = {}): Handlers {
  const handlers: Handlers = {
    onTrayEnabledChange: vi.fn(),
    onCloseToTrayChange: vi.fn(),
    onLaunchAtLoginChange: vi.fn(),
  }
  render(
    <TraySection
      trayEnabled={overrides.trayEnabled ?? true}
      closeToTray={overrides.closeToTray ?? false}
      launchAtLogin={overrides.launchAtLogin ?? false}
      launchAtLoginStatus={overrides.launchAtLoginStatus}
      {...handlers}
    />,
  )
  return handlers
}

/** A status record for an attempt that tried to reach `requested`. */
function status(fields: Partial<LaunchAtLoginStatus>): LaunchAtLoginStatus {
  return {
    supported: true,
    applied: true,
    requested: true,
    at: '2026-08-17T10:00:00.000Z',
    ...fields,
  }
}

const trayBox = () => screen.getByLabelText(LABELS.enabled)
const closeBox = () => screen.getByLabelText(LABELS.closeToTray)
const loginBox = () => screen.getByLabelText(LABELS.launchAtLogin)

afterEach(() => {
  cleanup()
})

describe('TraySection', () => {
  it('reflects the persisted values', () => {
    renderSection({ trayEnabled: true, closeToTray: true, launchAtLogin: true })

    expect(trayBox()).toBeChecked()
    expect(closeBox()).toBeChecked()
    expect(loginBox()).toBeChecked()
  })

  it('reflects the schema defaults (tray on, the other two off)', () => {
    renderSection()

    expect(trayBox()).toBeChecked()
    expect(closeBox()).not.toBeChecked()
    expect(loginBox()).not.toBeChecked()
  })

  it('reports a tray icon change', () => {
    const h = renderSection({ trayEnabled: true })

    fireEvent.click(trayBox())

    expect(h.onTrayEnabledChange).toHaveBeenCalledWith(false)
  })

  it('reports a launch-at-login change', () => {
    const h = renderSection({ launchAtLogin: false })

    fireEvent.click(loginBox())

    expect(h.onLaunchAtLoginChange).toHaveBeenCalledWith(true)
  })

  it('reports a close-to-tray change while the tray icon is on', () => {
    const h = renderSection({ trayEnabled: true, closeToTray: false })

    fireEvent.click(closeBox())

    expect(h.onCloseToTrayChange).toHaveBeenCalledWith(true)
  })

  it('disables close-to-tray when the tray icon is off', () => {
    renderSection({ trayEnabled: false })

    expect(closeBox()).toBeDisabled()
    // The two independent toggles stay operable.
    expect(trayBox()).toBeEnabled()
    expect(loginBox()).toBeEnabled()
  })

  it('does not report a close-to-tray change while disabled', () => {
    const h = renderSection({ trayEnabled: false, closeToTray: false })

    fireEvent.click(closeBox())

    expect(h.onCloseToTrayChange).not.toHaveBeenCalled()
  })

  it('states the Linux no-tray consequence regardless of the toggle state', () => {
    renderSection({ trayEnabled: false })
    expect(screen.getByText(LABELS.note)).toBeInTheDocument()

    cleanup()
    renderSection({ trayEnabled: true })
    expect(screen.getByText(LABELS.note)).toBeInTheDocument()
  })

  describe('launch-at-login honesty (review H4)', () => {
    it('says nothing when no attempt has ever been made', () => {
      renderSection({ launchAtLogin: true })

      expect(screen.queryByText(LABELS.unsupported)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.disableFailed)).not.toBeInTheDocument()
    })

    it('says nothing when the last attempt actually applied', () => {
      renderSection({ launchAtLogin: true, launchAtLoginStatus: status({ applied: true }) })

      expect(screen.queryByText(LABELS.unsupported)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
    })

    it('says nothing when a disable actually applied', () => {
      renderSection({
        launchAtLogin: false,
        launchAtLoginStatus: status({ applied: true, requested: false }),
      })

      expect(screen.queryByText(LABELS.disableFailed)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
    })

    it('states that the platform or build cannot register autostart', () => {
      renderSection({
        launchAtLogin: true,
        launchAtLoginStatus: status({ supported: false, applied: false }),
      })

      expect(screen.getByText(LABELS.unsupported)).toBeInTheDocument()
      // The failure note would be noise: nothing will be retried here.
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
    })

    it('states that a supported registration failed and will be retried', () => {
      renderSection({
        launchAtLogin: true,
        launchAtLoginStatus: status({ supported: true, applied: false, requested: true }),
      })

      expect(screen.getByText(LABELS.failed)).toBeInTheDocument()
      expect(screen.queryByText(LABELS.unsupported)).not.toBeInTheDocument()
      // The enable wording must not be used for the opposite direction.
      expect(screen.queryByText(LABELS.disableFailed)).not.toBeInTheDocument()
    })

    /**
     * Review round 2, HIGH-1. The autostart entry could not be REMOVED, so the
     * app still launches at login while the toggle reads unchecked. Gating the
     * note on `requested === true` hid exactly this case — the silent one, and
     * the one where something keeps happening against the user's wish.
     */
    it('warns when a disable failed and the app will still launch at login', () => {
      renderSection({
        launchAtLogin: false,
        launchAtLoginStatus: status({ supported: true, applied: false, requested: false }),
      })

      expect(screen.getByTestId('settings-tray-launch-failed')).toBeInTheDocument()
      expect(screen.getByText(LABELS.disableFailed)).toBeInTheDocument()
      // The enable wording would claim the opposite consequence.
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.unsupported)).not.toBeInTheDocument()
    })

    it('tells the two failure directions apart by consequence, not by tone', () => {
      // Guards against collapsing both into one vague shared sentence: the user
      // must be able to tell "it will not start" from "it still will".
      expect(LABELS.failed).not.toBe(LABELS.disableFailed)
    })

    it('keeps the toggle operable while unsupported, so the wish can still be withdrawn', () => {
      const h = renderSection({
        launchAtLogin: true,
        launchAtLoginStatus: status({ supported: false, applied: false }),
      })

      expect(loginBox()).toBeEnabled()
      fireEvent.click(loginBox())
      expect(h.onLaunchAtLoginChange).toHaveBeenCalledWith(false)
    })

    it('does not report a stale failed enable once the wish is withdrawn', () => {
      // The user has since turned autostart OFF; the record is about the failed
      // attempt to turn it ON, so repeating it here would be misleading. The
      // pending disable has not been attempted yet — it has nothing to report.
      renderSection({
        launchAtLogin: false,
        launchAtLoginStatus: status({ supported: true, applied: false, requested: true }),
      })

      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.disableFailed)).not.toBeInTheDocument()
    })

    it('does not report a stale failed disable once autostart is wanted again', () => {
      // Mirror of the case above: the record describes a failed REMOVAL, while
      // the toggle now asks for autostart. Currency is symmetric.
      renderSection({
        launchAtLogin: true,
        launchAtLoginStatus: status({ supported: true, applied: false, requested: false }),
      })

      expect(screen.queryByText(LABELS.disableFailed)).not.toBeInTheDocument()
      expect(screen.queryByText(LABELS.failed)).not.toBeInTheDocument()
    })

    it('still reports an unsupported platform regardless of the current wish', () => {
      // Capability is a property of the machine, not of what was requested.
      renderSection({
        launchAtLogin: false,
        launchAtLoginStatus: status({ supported: false, applied: false, requested: true }),
      })

      expect(screen.getByText(LABELS.unsupported)).toBeInTheDocument()
    })
  })

  it('renders no untranslated key placeholders', () => {
    const { container } = render(
      <TraySection
        trayEnabled
        closeToTray
        launchAtLogin
        onTrayEnabledChange={vi.fn()}
        onCloseToTrayChange={vi.fn()}
        onLaunchAtLoginChange={vi.fn()}
      />,
    )

    expect(container.textContent).not.toContain('settings.tray.')
  })
})
