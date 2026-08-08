import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'

/**
 * §2.19 — System info + auto-update controls for Settings → About.
 *
 * Owns:
 *  1. Read-only system info (versions, install path, channel badge).
 *  2. The "Automatically download updates" checkbox (controlled — actual
 *     persistence happens in the parent Settings.tsx alongside other
 *     settings via `settings:save`).
 *  3. The "Check for updates" button + state machine
 *     (idle → checking → up-to-date | available | error |
 *      downloading N% → downloaded → restart-to-install).
 *
 * Why extracted: AC9 (hotspot policy) — Settings.tsx is already 3.5k LOC.
 * Adding ~200 LOC of update UI + a non-trivial state machine inline would
 * push it further into "untouchable" territory. The component owns its
 * status state and event subscriptions; the parent supplies only the
 * controlled checkbox value/setter so the standard "Save" button still
 * works the same way.
 *
 * IPC contracts (see electron/preload.ts whitelist + electron/main.ts):
 *  - Outbound:
 *      `update:systemInfo` → SystemInfoPayload | null (one-shot on mount;
                            null = sender is not the settings window)
 *      `update:check`      → { ok, status, version?, error_class? }
 *      `update:download`   → { ok, reason? }
 *      `update:install`    → { ok }
 *  - Inbound (subscriptions cleaned up on unmount):
 *      `update:available`        — { version, canSelfUpdate }
 *      `update:downloadProgress` — { percent, transferred, total }
 *      `update:downloaded`       — (no payload)
 *      `update:checkResult`      — { status, version?, error_class? }
 *      `update:downloadFailed`   — { error_class? }
 */

/**
 * §2.58 — mirrors `SelfUpdateBlockedReason` in electron/services/updateCheck.ts.
 * Main and renderer ship in the same artifact, so this is a copy of one enum,
 * not a compatibility surface across versions.
 */
type SelfUpdateBlockedReason = 'not-packaged' | 'no-in-place-target' | 'target-dir-readonly'

/**
 * Reason → warning string. Exhaustive by type: adding a reason in main without
 * a translated explanation here is a compile error, not a silent fallback.
 * 'not-packaged' never reaches this map in practice (the dedicated
 * "unsupported" state covers dev builds) but is mapped anyway so the record
 * stays total.
 */
const SELF_UPDATE_WARNING_KEY: Record<SelfUpdateBlockedReason, string> = {
  'not-packaged': 'settings.about.update.cannotSelfUpdateUnknown',
  'no-in-place-target': 'settings.about.update.cannotSelfUpdateNoTarget',
  'target-dir-readonly': 'settings.about.update.cannotSelfUpdateHint',
}

/**
 * The payload crosses IPC, so its `selfUpdateBlockedReason` is only *declared*
 * to be the enum. Narrow at runtime and fall back to the neutral wording —
 * never invent a diagnosis (telling the user "folder not writable" when the
 * reason is unknown is worse than saying nothing specific).
 */
function isKnownBlockedReason(value: unknown): value is SelfUpdateBlockedReason {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SELF_UPDATE_WARNING_KEY, value)
}

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
  /**
   * §2.58 — enum reason behind canSelfUpdate=false (null when true).
   * Optional so a test fixture can omit it; an omitted/unknown value yields
   * the neutral warning, not a guessed one.
   */
  selfUpdateBlockedReason?: SelfUpdateBlockedReason | null
  isPackaged: boolean
}

type CheckStatus =
  | { kind: 'idle' }
  | { kind: 'unsupported' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded' }
  | { kind: 'error'; errorClass?: string }

type Props = {
  /** Controlled value — parent owns persistence via settings:save. */
  autoUpdateEnabled: boolean
  /** Setter — parent flips the unsavedChanges snapshot on user toggle. */
  onAutoUpdateEnabledChange: (next: boolean) => void
}

export default function SystemInfo({ autoUpdateEnabled, onAutoUpdateEnabledChange }: Props) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<SystemInfoPayload | null>(null)
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' })
  // Latest known available version — surfaces inline next to "Current version"
  // even when the status pill has rotated through several states. Cleared
  // when an explicit "up-to-date" result lands.
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  // Guard against state updates after unmount (manual check is async).
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Fetch system info once on mount. The payload is static at runtime.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.api.invoke<SystemInfoPayload | null>('update:systemInfo')
        if (cancelled || !mountedRef.current) return
        // §2.58 iter2 — main answers `null` when the caller is not the
        // settings window (the payload carries the install path). This panel
        // only ever renders inside that window, so `null` here means a wiring
        // regression, not a user-facing state: keep `info === null` and show
        // the static version, exactly like an IPC failure.
        if (!res) return
        setInfo(res)
        // In dev/e2e the autoUpdater is disabled — surface that as a
        // dedicated state so the button can be hidden cleanly.
        if (!res.isPackaged) {
          setStatus({ kind: 'unsupported' })
        }
      } catch {
        // System info IPC should never fail in practice — fall back to
        // showing the static __APP_VERSION__ via the optional chain below.
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Subscribe to background update events. The autoUpdater hourly poll can
  // surface 'available' / 'downloaded' independent of any user click, so the
  // state machine must react to inbound events the same way as its own
  // returned promises.
  useEffect(() => {
    const onAvailable = (payload: unknown) => {
      const data = payload as { version?: string }
      const version = String(data?.version ?? '')
      if (version) setLatestVersion(version)
      setStatus({ kind: 'available', version })
    }
    const onProgress = (payload: unknown) => {
      const data = payload as { percent?: number }
      const percent = Math.max(0, Math.min(100, Math.floor(typeof data?.percent === 'number' ? data.percent : 0)))
      setStatus({ kind: 'downloading', percent })
    }
    const onDownloaded = () => {
      setStatus({ kind: 'downloaded' })
    }
    const onCheckResult = (payload: unknown) => {
      const data = payload as { status?: string; version?: string; error_class?: string }
      if (data?.status === 'available') {
        const version = String(data.version ?? '')
        if (version) setLatestVersion(version)
        setStatus({ kind: 'available', version })
      } else if (data?.status === 'up-to-date') {
        setLatestVersion(null)
        setStatus({ kind: 'up-to-date' })
      } else if (data?.status === 'error') {
        setStatus({ kind: 'error', errorClass: data.error_class })
      }
    }
    const onDownloadFailed = (payload: unknown) => {
      const data = payload as { error_class?: string }
      setStatus({ kind: 'error', errorClass: data?.error_class })
    }
    window.api?.on('update:available', onAvailable)
    window.api?.on('update:downloadProgress', onProgress)
    window.api?.on('update:downloaded', onDownloaded)
    window.api?.on('update:checkResult', onCheckResult)
    window.api?.on('update:downloadFailed', onDownloadFailed)
    return () => {
      window.api?.off('update:available', onAvailable)
      window.api?.off('update:downloadProgress', onProgress)
      window.api?.off('update:downloaded', onDownloaded)
      window.api?.off('update:checkResult', onCheckResult)
      window.api?.off('update:downloadFailed', onDownloadFailed)
    }
  }, [])

  const handleCheck = useCallback(async () => {
    if (!info?.isPackaged) return
    setStatus({ kind: 'checking' })
    try {
      const res = await window.api.invoke<{
        ok: boolean
        status: 'unsupported' | 'checking' | 'up-to-date' | 'available' | 'error'
        version?: string
        error_class?: string
      }>('update:check')
      if (!mountedRef.current) return
      if (res.status === 'available' && res.version) {
        setLatestVersion(res.version)
        setStatus({ kind: 'available', version: res.version })
      } else if (res.status === 'up-to-date') {
        setLatestVersion(null)
        setStatus({ kind: 'up-to-date' })
      } else if (res.status === 'error') {
        setStatus({ kind: 'error', errorClass: res.error_class })
      } else if (res.status === 'unsupported') {
        setStatus({ kind: 'unsupported' })
      }
    } catch {
      if (!mountedRef.current) return
      setStatus({ kind: 'error' })
    }
  }, [info?.isPackaged])

  const handleDownload = useCallback(() => {
    setStatus(prev => prev.kind === 'available'
      ? { kind: 'downloading', percent: 0 }
      : prev)
    void window.api.invoke<{ ok: boolean; reason?: string }>('update:download').then((res) => {
      if (!mountedRef.current) return
      if (res && !res.ok) {
        setStatus({ kind: 'error' })
      }
    }).catch(() => {
      if (!mountedRef.current) return
      setStatus({ kind: 'error' })
    })
  }, [])

  const handleInstall = useCallback(() => {
    void window.api.invoke('update:install').catch(() => { /* dialog shown in main */ })
  }, [])

  const channelLabel = info ? t(`settings.about.system.channel.${info.channel}`) : ''
  const canSelfUpdate = info?.canSelfUpdate ?? false
  // §2.58 — the warning explains *why* in-place update is unavailable, but it
  // never takes the checkbox away: the user stays in control of the setting
  // (main still suppresses the pointless background download). 'not-packaged'
  // is already covered by the dedicated "unsupported" state below.
  const selfUpdateBlocked = Boolean(info && info.isPackaged && !canSelfUpdate)
  const blockedReason = info?.selfUpdateBlockedReason
  const selfUpdateWarning = !selfUpdateBlocked
    ? null
    : isKnownBlockedReason(blockedReason)
      ? t(SELF_UPDATE_WARNING_KEY[blockedReason])
      // Missing/unrecognised reason: say that self-update is unavailable and
      // stop there. Guessing a cause misinforms the user and sends them
      // chasing a permission problem that may not exist.
      : t('settings.about.update.cannotSelfUpdateUnknown')

  return (
    <div className="settings-system-info" data-testid="settings-about-system">
      <h4 style={{ margin: '0 0 8px' }}>
        <Cpu size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
        {t('settings.about.system.title')}
      </h4>

      <div className="setting-row">
        <label>{t('settings.about.system.appVersion')}:</label>
        <span data-testid="settings-about-app-version">
          {info?.appVersion ?? __APP_VERSION__}
          {info && (
            <span
              className={`channel-badge channel-badge-${info.channel}`}
              data-testid="settings-about-channel"
              style={{
                marginLeft: 8,
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 500,
                background: 'var(--bg-secondary, #f5f5f5)',
                color: 'var(--text-secondary, #666)',
                textTransform: 'uppercase',
              }}
            >
              {channelLabel}
            </span>
          )}
          {latestVersion && (
            <span
              className="hint"
              data-testid="settings-about-latest-version"
              style={{ marginLeft: 8 }}
            >
              ({t('settings.about.system.latestAvailable', { version: latestVersion })})
            </span>
          )}
        </span>
      </div>

      {info && (
        <>
          <div className="setting-row">
            <label>{t('settings.about.system.electron')}:</label>
            <span data-testid="settings-about-electron">{info.electron}</span>
          </div>
          <div className="setting-row">
            <label>{t('settings.about.system.chromium')}:</label>
            <span data-testid="settings-about-chromium">{info.chromium}</span>
          </div>
          <div className="setting-row">
            <label>{t('settings.about.system.node')}:</label>
            <span data-testid="settings-about-node">{info.node}</span>
          </div>
          <div className="setting-row">
            <label>{t('settings.about.system.platform')}:</label>
            <span data-testid="settings-about-platform">{info.platform} ({info.arch})</span>
          </div>
          <div className="setting-row">
            <label>{t('settings.about.system.installPath')}:</label>
            <span data-testid="settings-about-install-path">
              {/* uiaudit.12 — wrap in <code> so long paths break at word
                  boundaries instead of mid-letter. overflow-wrap:anywhere
                  covers edge cases where no slash is present. */}
              <code style={{ fontSize: 12, wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: 0.9 }}>
                {info.installPath}
              </code>
              {!info.installPathWritable && (
                <span
                  className="hint"
                  data-testid="settings-about-install-readonly"
                  style={{ marginLeft: 6, color: 'var(--warning, #f59e0b)' }}
                >
                  ({t('settings.about.system.readOnly')})
                </span>
              )}
            </span>
          </div>
        </>
      )}

      <hr style={{ margin: '16px 0', borderColor: 'var(--border)' }} />

      <h4 style={{ margin: '0 0 8px' }}>
        <Download size={14} style={{ marginRight: 4, verticalAlign: -2 }} />
        {t('settings.about.update.title')}
      </h4>

      <label
        className="setting-check"
        title={selfUpdateWarning ?? undefined}
      >
        <input
          type="checkbox"
          data-testid="settings-about-auto-update"
          checked={autoUpdateEnabled}
          onChange={e => onAutoUpdateEnabledChange(e.target.checked)}
        />
        {t('settings.about.update.autoDownload')}
      </label>
      {/* §2.58 — warning, not a lockout: the control above stays operable so
          the user can still change the preference (and see it persist) even
          on a build that cannot replace itself in place. */}
      {selfUpdateWarning !== null && (
        <p
          className="hint"
          data-testid="settings-about-self-update-warning"
          style={{ color: 'var(--warning, #f59e0b)' }}
        >
          <AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          {selfUpdateWarning}
        </p>
      )}
      <p className="hint">
        {t('settings.about.update.autoDownloadHint')}
      </p>

      {/* Action button — state-machine driven */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {status.kind === 'unsupported' && (
          <span
            className="hint"
            data-testid="settings-about-update-unsupported"
          >
            {t('settings.about.update.unsupportedDev')}
          </span>
        )}

        {status.kind !== 'unsupported' && status.kind !== 'downloaded' && (
          <button
            className="btn-secondary"
            data-testid="settings-about-check-update"
            disabled={status.kind === 'checking' || status.kind === 'downloading' || !info?.isPackaged}
            onClick={() => void handleCheck()}
          >
            <RefreshCw
              size={14}
              className={status.kind === 'checking' ? 'spin' : ''}
              style={status.kind === 'checking' ? { animation: 'spin 1s linear infinite' } : undefined}
            />
            {' '}
            {status.kind === 'checking'
              ? t('settings.about.update.checking')
              : t('settings.about.update.checkNow')}
          </button>
        )}

        {status.kind === 'available' && canSelfUpdate && (
          <button
            className="btn-primary"
            data-testid="settings-about-download-update"
            onClick={handleDownload}
          >
            <Download size={14} />
            {' '}
            {t('settings.about.update.downloadVersion', { version: status.version })}
          </button>
        )}

        {status.kind === 'downloading' && (
          <span data-testid="settings-about-update-downloading">
            <Download size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            {t('settings.about.update.downloadingPercent', { percent: status.percent })}
          </span>
        )}

        {status.kind === 'downloaded' && canSelfUpdate && (
          <button
            className="btn-primary"
            data-testid="settings-about-restart-update"
            onClick={handleInstall}
          >
            <CheckCircle size={14} />
            {' '}
            {t('settings.about.update.restartToInstall')}
          </button>
        )}

        {status.kind === 'up-to-date' && (
          <span
            className="hint"
            data-testid="settings-about-update-uptodate"
            style={{ color: 'var(--success, #22c55e)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <CheckCircle size={14} />
            {t('settings.about.update.upToDate')}
          </span>
        )}

        {status.kind === 'error' && (
          <span
            className="hint"
            data-testid="settings-about-update-error"
            style={{ color: 'var(--danger, #ef4444)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <AlertCircle size={14} />
            {status.errorClass === 'network'
              ? t('settings.about.update.errorNetwork')
              : status.errorClass === 'permission'
                ? t('settings.about.update.errorPermission')
                : t('settings.about.update.errorUnknown')}
          </span>
        )}
      </div>
    </div>
  )
}
