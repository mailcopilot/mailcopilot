/**
 * §2.99 — "start MailCopilot when I log in".
 *
 * Two mechanisms, because Electron only has one: `setLoginItemSettings` covers
 * macOS and Windows and is a no-op elsewhere (`@platform darwin,win32`), so
 * Linux gets the freedesktop autostart entry — a `.desktop` file in
 * `$XDG_CONFIG_HOME/autostart` — written here.
 *
 * HONEST DEGRADATION is the whole point of the return value. An unpackaged
 * build has no stable executable to point at (the "app" is a dev server plus an
 * electron binary in node_modules), and a session with no writable config dir
 * cannot be made to autostart at all. Both answer `supported: false`, the
 * setting keeps whatever the user chose, nothing throws into a settings-save
 * path, and the UI can hide or explain the switch instead of pretending.
 */

import path from 'node:path'
import { createLogger } from '../logger'
import { captureException } from '../sentry'

const log = createLogger('LaunchAtLogin')

export type LaunchAtLoginOutcome = {
  /** Can this build on this platform register itself at all? */
  supported: boolean
  /** Did the requested state get applied? False with supported=true means it failed. */
  applied: boolean
}

export interface LaunchAtLoginDeps {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** electron `app.setLoginItemSettings` (macOS / Windows). */
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void
  /** Directory of freedesktop autostart entries (Linux). */
  autostartDir: string
  /** Executable to launch — the AppImage path when there is one. */
  execPath: string
  appName: string
  fs: {
    mkdirSync: (dir: string, options: { recursive: true }) => void
    writeFileSync: (file: string, data: string, encoding: 'utf8') => void
    rmSync: (file: string, options: { force: true }) => void
  }
}

/** Desktop-entry string escaping: backslash first, then the quote. */
function escapeExec(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * May this path be written into a desktop entry? (security review LOW-1)
 *
 * Quoting handles spaces, quotes and backslashes, but the desktop-entry format
 * is LINE-BASED: a carriage return or newline in the value ends the `Exec=`
 * line and everything after it becomes further entry keys — an executable line
 * of the attacker's choosing, launched at every login. NUL is rejected for the
 * same class of reason (it truncates for whoever reads the file with C string
 * semantics, so what we wrote and what the session reads can differ).
 *
 * The value is `process.env.APPIMAGE` or `process.execPath`; the former is
 * attacker-controlled in the sense that matters here (anything that can set the
 * environment of our process could otherwise plant a login item that outlives
 * this session). An absolute path is required for the same reason the autostart
 * directory must be absolute: a relative `Exec` resolves against whatever
 * working directory the session manager happens to have.
 */
export function isSafeExecPath(execPath: string): boolean {
  if (typeof execPath !== 'string' || execPath.length === 0) return false
  if (/[\r\n\0]/.test(execPath)) return false
  return path.isAbsolute(execPath)
}

export function autostartEntryPath(deps: Pick<LaunchAtLoginDeps, 'autostartDir'>): string {
  return path.join(deps.autostartDir, 'mailcopilot.desktop')
}

export function buildDesktopEntry(appName: string, execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${appName}`,
    `Exec="${escapeExec(execPath)}"`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

/**
 * Apply the requested state. Never throws — the caller is a settings-save path
 * and a failed OS registration must not lose the rest of the save.
 */
export function applyLaunchAtLogin(enabled: boolean, deps: LaunchAtLoginDeps): LaunchAtLoginOutcome {
  // A dev/e2e build would register the electron binary from node_modules, which
  // is not the app the user thinks they enabled.
  if (!deps.isPackaged) return { supported: false, applied: false }
  try {
    if (deps.platform === 'darwin' || deps.platform === 'win32') {
      deps.setLoginItemSettings({ openAtLogin: enabled })
      return { supported: true, applied: true }
    }
    if (deps.platform === 'linux') {
      const file = autostartEntryPath(deps)
      // Refuse to write an entry we cannot serialise safely — an honest
      // failure the UI already knows how to report (`launchAtLoginStatus`),
      // never a partially-trusted `Exec` line. Removal is unaffected: it
      // deletes a path we built ourselves.
      if (enabled && !isSafeExecPath(deps.execPath)) {
        log.warn('Refusing to write an autostart entry: the executable path is not a safe absolute path')
        captureException(new Error('launchAtLogin unsafe exec path'), {
          source: 'launchAtLogin:unsafeExecPath',
          platform: deps.platform,
          length: deps.execPath?.length ?? 0,
        })
        return { supported: true, applied: false }
      }
      if (enabled) {
        deps.fs.mkdirSync(deps.autostartDir, { recursive: true })
        deps.fs.writeFileSync(file, buildDesktopEntry(deps.appName, deps.execPath), 'utf8')
      } else {
        deps.fs.rmSync(file, { force: true })
      }
      return { supported: true, applied: true }
    }
    return { supported: false, applied: false }
  } catch (err) {
    // No path, no home directory, no error text from the OS beyond the class:
    // this reaches Sentry, and the file path names the user's account.
    log.warn('Applying launch-at-login failed:', err)
    captureException(new Error('launchAtLogin apply failed'), {
      source: 'launchAtLogin:apply',
      platform: deps.platform,
      enabled,
    })
    return { supported: true, applied: false }
  }
}
