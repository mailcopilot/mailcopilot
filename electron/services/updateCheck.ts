import fs from 'node:fs'
import path from 'node:path'
import { isTransientNetworkError, isLinuxInstallerError } from '@mailcopilot/core'

/**
 * Check if the current user has write access to the directory containing the app executable.
 * When the app is installed system-wide by an administrator (e.g. from a .deb package to /opt/),
 * the user typically lacks write permissions, meaning electron-updater cannot replace the binary.
 */
export function canWriteAppDir(execPath: string): boolean {
  try {
    fs.accessSync(path.dirname(execPath), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * §2.19 — bucketed error classification for update.* telemetry.
 *
 * Privacy invariant: telemetry tags must be enums, not raw error messages
 * (which can leak path components, version strings, server hostnames, etc.).
 * This taxonomy is intentionally tiny — three buckets cover the full failure
 * surface of electron-updater + Linux installers without cardinality blowup:
 *
 *   - 'network'    — transient connectivity (proxy drop, VPN, sleep, DNS).
 *                    Mirrors the suppression rule in `autoUpdater.on('error')`
 *                    so a single dashboard signal lines up with what we DON'T
 *                    forward to Sentry.
 *   - 'permission' — write/exec permission denied (read-only install dir,
 *                    pkexec/dpkg refusal, EACCES). User needs admin help.
 *   - 'unknown'    — anything else. Forward-compat: a future failure mode
 *                    surfaces here and we get a Sentry breadcrumb to triage,
 *                    no schema bump required.
 *
 * Returned values match the `error_class` tag domain in metricsSchema.ts.
 */
export type UpdateErrorClass = 'network' | 'permission' | 'unknown'

export function classifyUpdateError(err: unknown): UpdateErrorClass {
  if (isTransientNetworkError(err)) return 'network'
  if (isLinuxInstallerError(err)) return 'permission'
  // Heuristic for write-permission failures (root-owned install path on
  // Linux/macOS, NSIS write failures on Windows, sandbox quirks on macOS).
  // Plain text codes are PII-clean — they're error-system constants, not
  // user data.
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code.toUpperCase()
      : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission'
  // electron-updater raises plain Error('access denied') in some signature
  // paths — match conservatively on the message text.
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  if (msg.includes('permission denied') || msg.includes('access denied')) return 'permission'
  return 'unknown'
}

/**
 * §2.19 — system info exposed in Settings → About → System Info panel.
 *
 * All fields are static at runtime (process.versions, app.getVersion(),
 * process.platform, etc.) so the renderer can fetch this once on Settings
 * open. No PII: install path is the absolute path to the app binary, which
 * is the same machine-local string already visible to any process the user
 * launches; we do not include the user's home directory or hostname.
 *
 * `channel`:
 *   - 'dev'     — running from source (vite/electron-forge), `app.isPackaged === false`.
 *   - 'nightly' — packaged build whose version contains `-nightly`/`-beta`/`-rc`.
 *   - 'stable'  — anything else (semantic-release stable tag).
 *
 * Channel is a UI badge only — autoUpdater feed routing is configured by
 * electron-builder.json5 / publish target, not by this enum.
 */
export type UpdateChannel = 'dev' | 'nightly' | 'stable'

export function detectUpdateChannel(version: string, isPackaged: boolean): UpdateChannel {
  if (!isPackaged) return 'dev'
  const lower = version.toLowerCase()
  if (lower.includes('-nightly') || lower.includes('-beta') || lower.includes('-rc') || lower.includes('-alpha')) {
    return 'nightly'
  }
  return 'stable'
}

export type SystemInfo = {
  appVersion: string
  channel: UpdateChannel
  electron: string
  chromium: string
  node: string
  platform: NodeJS.Platform
  arch: string
  installPath: string
  installPathWritable: boolean
  /**
   * False when `app.isPackaged === false` (dev/e2e) OR when the install
   * path is not writable by the current user (system-wide install).
   * Drives the disabled state of the "auto-download" checkbox.
   */
  canSelfUpdate: boolean
  isPackaged: boolean
}
