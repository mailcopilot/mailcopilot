import { useTranslation } from 'react-i18next'

/**
 * Main's report of the last autostart registration attempt (§2.99 review H4).
 * Main-only writable — this component displays it and never produces it.
 */
export type LaunchAtLoginStatus = {
  supported: boolean
  applied: boolean
  requested: boolean
  at: string
}

export type TraySectionProps = {
  trayEnabled: boolean
  onTrayEnabledChange: (value: boolean) => void
  closeToTray: boolean
  onCloseToTrayChange: (value: boolean) => void
  launchAtLogin: boolean
  onLaunchAtLoginChange: (value: boolean) => void
  /** Absent means "never attempted", which is not the same as "failed". */
  launchAtLoginStatus?: LaunchAtLoginStatus
}

/**
 * §2.99 — tray, close-to-tray and launch-at-login toggles.
 *
 * Extracted from `Settings.tsx` (a §5 hotspot) rather than inlined. Two
 * non-obvious rules live here:
 *
 * 1. `closeToTray` is subordinate to `trayEnabled`, because closing to a tray
 *    icon that is not shown would hide the window with no obvious way back.
 *    Turning the tray off therefore disables the dependent toggle instead of
 *    silently ignoring it.
 * 2. `launchAtLogin` is a WISH; `launchAtLoginStatus` is the OUTCOME. Showing
 *    only the wish would be a lie on a platform or build that cannot register
 *    autostart, so the outcome is stated whenever it contradicts the wish.
 */
export default function TraySection({
  trayEnabled,
  onTrayEnabledChange,
  closeToTray,
  onCloseToTrayChange,
  launchAtLogin,
  onLaunchAtLoginChange,
  launchAtLoginStatus,
}: TraySectionProps) {
  const { t } = useTranslation()

  // The record describes ONE past attempt. It may only speak about the toggle
  // as it stands now — otherwise flipping autostart back off would keep showing
  // the failure of the opposite request until the next save overwrote it.
  //
  // Currency is the WHOLE test (review round 2, HIGH-1). Requiring `requested`
  // to be true as well looked like a harmless tightening but silently dropped
  // the failed DISABLE: when the autostart entry cannot be removed, the toggle
  // reads unchecked while the app still launches at login — the exact lie this
  // section exists to prevent, and the more alarming direction of the two,
  // because something keeps happening against the user's wish.
  const statusDescribesCurrentWish = launchAtLoginStatus?.requested === launchAtLogin
  const autostartUnsupported = launchAtLoginStatus?.supported === false
  const autostartFailed =
    launchAtLoginStatus?.supported === true &&
    statusDescribesCurrentWish &&
    !launchAtLoginStatus.applied
  // The consequences are opposites — "it will not start" vs "it still will" —
  // so the direction gets its own sentence rather than one vague shared one.
  const autostartFailureKey = launchAtLogin
    ? 'settings.tray.launchAtLoginFailed'
    : 'settings.tray.launchAtLoginDisableFailed'

  return (
    <>
      <label className="setting-row setting-row-start">
        <input
          type="checkbox"
          data-testid="settings-tray-enabled"
          checked={trayEnabled}
          onChange={e => onTrayEnabledChange(e.target.checked)}
        />
        {t('settings.tray.enabled')}
      </label>

      <label
        className="setting-row setting-row-start"
        style={{ marginLeft: 20, opacity: trayEnabled ? 1 : 0.5 }}
      >
        <input
          type="checkbox"
          data-testid="settings-tray-close-to-tray"
          checked={closeToTray}
          disabled={!trayEnabled}
          // Guarded as well as disabled: the subordination is a rule about the
          // setting, not a property of this markup, so it must hold even if the
          // attribute is ever lost to a restyle.
          onChange={e => { if (trayEnabled) onCloseToTrayChange(e.target.checked) }}
        />
        {t('settings.tray.closeToTray')}
      </label>
      {/*
        §2.228 — the note states what actually happens, not a hoped-for
        degradation: `new Tray()` succeeds on Linux even with no tray host, so
        close-to-tray DOES hide the window on a desktop that draws no icon.
        Hence the recovery action (relaunching, which `second-instance` routes
        to `showMainWindow()`) is part of the sentence, not just the warning.
      */}
      <span className="hint" style={{ marginLeft: 20 }}>{t('settings.tray.linuxNoTrayNote')}</span>

      {/*
        The toggle stays operable even when the last attempt reported the
        capability as missing: the record describes that attempt, not this
        machine forever (an unpackaged build reports "unsupported" while the
        installed one can register), and locking the control on a stale record
        would take the setting away with no way to ask for it again. Honesty
        here is a statement, not a disabled input.
      */}
      <label className="setting-row setting-row-start">
        <input
          type="checkbox"
          data-testid="settings-tray-launch-at-login"
          checked={launchAtLogin}
          onChange={e => onLaunchAtLoginChange(e.target.checked)}
        />
        {t('settings.tray.launchAtLogin')}
      </label>
      {autostartUnsupported && (
        <span className="hint" data-testid="settings-tray-launch-unsupported">
          {t('settings.tray.launchAtLoginUnsupported')}
        </span>
      )}
      {autostartFailed && (
        <span className="hint" data-testid="settings-tray-launch-failed">
          {t(autostartFailureKey)}
        </span>
      )}
    </>
  )
}
