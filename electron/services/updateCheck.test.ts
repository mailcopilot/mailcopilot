import { describe, it, expect, afterEach, vi } from 'vitest'
import { decideUpdateIpcGate, isDirWritable, readLinuxPackageType, resolveSelfUpdateSupport } from './updateCheck'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('isDirWritable', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  it('returns true when directory is writable', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'))
    expect(isDirWritable(tmpDir)).toBe(true)
  })

  // Root ignores filesystem permission bits, so this test only works for non-root users.
  it.skipIf(process.getuid?.() === 0)('returns false when directory is read-only', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'))
    fs.chmodSync(tmpDir, 0o555)
    expect(isDirWritable(tmpDir)).toBe(false)
    // Restore permissions so cleanup works
    fs.chmodSync(tmpDir, 0o755)
  })

  it('returns false when directory does not exist', () => {
    expect(isDirWritable('/nonexistent-path-12345')).toBe(false)
  })

  /**
   * POSIX needs the directory search bit to resolve names inside it, so
   * `unlink(old) + rename(new)` — exactly what electron-updater does — requires
   * W_OK *and* X_OK. A W_OK-only probe accepts a 0o222 directory and the
   * install then fails. Asserted on the mask rather than on a real directory so
   * the check also holds when the suite runs as root (root bypasses permission
   * bits and every filesystem probe would pass).
   */
  it('probes for write AND search permission (W_OK | X_OK)', () => {
    const spy = vi.spyOn(fs, 'accessSync').mockImplementation(() => {})
    try {
      expect(isDirWritable('/some/install/dir')).toBe(true)
      expect(spy).toHaveBeenCalledWith('/some/install/dir', fs.constants.W_OK | fs.constants.X_OK)
    } finally {
      spy.mockRestore()
    }
  })

  // Same rule against the real filesystem. Root ignores permission bits.
  it.skipIf(process.getuid?.() === 0)('rejects a writable but non-searchable directory (0o222)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'))
    fs.chmodSync(tmpDir, 0o222)
    try {
      expect(isDirWritable(tmpDir)).toBe(false)
    } finally {
      // Restore permissions so cleanup can traverse the directory.
      fs.chmodSync(tmpDir, 0o755)
    }
  })
})

describe('readLinuxPackageType', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  it('returns the trimmed marker written by electron-builder', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-res-'))
    fs.writeFileSync(path.join(tmpDir, 'package-type'), 'deb\n')
    expect(readLinuxPackageType(tmpDir)).toBe('deb')
  })

  it('returns null when the marker is absent (the AppImage case)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-res-'))
    expect(readLinuxPackageType(tmpDir)).toBeNull()
  })

  it('returns null for an empty marker instead of an empty string', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-res-'))
    fs.writeFileSync(path.join(tmpDir, 'package-type'), '   \n')
    expect(readLinuxPackageType(tmpDir)).toBeNull()
  })
})

/**
 * §2.58 — the regression suite for the false "cannot self-update" verdict.
 *
 * The old predicate was `canWriteAppDir(process.execPath)`. On an AppImage,
 * execPath lives inside the read-only `/tmp/.mount_*` FUSE mount, so the probe
 * always failed and auto-update was structurally dead on the primary Linux
 * artifact. On .deb/.rpm the probe answered a question that isn't ours —
 * DebUpdater elevates via pkexec.
 */
describe('§2.58 resolveSelfUpdateSupport', () => {
  const APPIMAGE = '/home/user/Applications/MailCopilot-1.2.3.AppImage'
  const MOUNT_EXEC = '/tmp/.mount_mailco7Xk9Qz/mailcopilot'

  const linux = (overrides: Partial<Parameters<typeof resolveSelfUpdateSupport>[0]> = {}) =>
    resolveSelfUpdateSupport({
      platform: 'linux',
      isPackaged: true,
      execPath: MOUNT_EXEC,
      resourcesPath: '/tmp/.mount_mailco7Xk9Qz/resources',
      env: { APPIMAGE },
      isDirWritableImpl: () => true,
      readPackageTypeImpl: () => null,
      ...overrides,
    })

  it('AppImage — probes the AppImage directory, not the /tmp mount (the actual bug)', () => {
    const probed: string[] = []
    const result = linux({
      isDirWritableImpl: (dir) => { probed.push(dir); return true },
    })
    expect(probed).toEqual(['/home/user/Applications'])
    // The /tmp mount must never be the deciding directory.
    expect(probed[0]).not.toContain('.mount_')
    expect(result).toEqual({
      kind: 'appimage',
      targetDir: '/home/user/Applications',
      canSelfUpdate: true,
      blockedReason: null,
    })
  })

  it('AppImage in a read-only directory — blocked with the target-dir reason', () => {
    const result = linux({ isDirWritableImpl: () => false })
    expect(result.canSelfUpdate).toBe(false)
    expect(result.blockedReason).toBe('target-dir-readonly')
    expect(result.kind).toBe('appimage')
  })

  it('Linux packaged build without APPIMAGE — mirrors AppImageUpdater.isUpdaterActive()=false', () => {
    // Extracted AppImage / raw linux-unpacked tree / SNAP: electron-updater
    // refuses regardless of permissions, so we must not probe a directory
    // and must not promise self-update.
    const result = linux({ env: {}, isDirWritableImpl: () => { throw new Error('must not probe') } })
    expect(result).toEqual({
      kind: 'appimage',
      targetDir: null,
      canSelfUpdate: false,
      blockedReason: 'no-in-place-target',
    })
  })

  it('rejects a relative or NUL-poisoned APPIMAGE value instead of probing a bogus dir', () => {
    for (const bad of ['relative/path.AppImage', '/home/user/app\0.AppImage', '']) {
      const result = linux({ env: { APPIMAGE: bad }, isDirWritableImpl: () => { throw new Error('must not probe') } })
      expect(result.canSelfUpdate).toBe(false)
      expect(result.blockedReason).toBe('no-in-place-target')
    }
  })

  it('.deb — never pre-blocked, even when the install dir is unwritable (pkexec elevates)', () => {
    const result = resolveSelfUpdateSupport({
      platform: 'linux',
      isPackaged: true,
      execPath: '/opt/MailCopilot/mailcopilot',
      resourcesPath: '/opt/MailCopilot/resources',
      env: {},
      isDirWritableImpl: () => { throw new Error('must not probe for distro packages') },
      readPackageTypeImpl: () => 'deb',
    })
    expect(result).toEqual({
      kind: 'linux-package',
      targetDir: null,
      canSelfUpdate: true,
      blockedReason: null,
    })
  })

  it('.rpm and pacman follow the same rule as .deb', () => {
    for (const pkg of ['rpm', 'pacman']) {
      const result = resolveSelfUpdateSupport({
        platform: 'linux',
        isPackaged: true,
        execPath: '/opt/MailCopilot/mailcopilot',
        resourcesPath: '/opt/MailCopilot/resources',
        env: {},
        isDirWritableImpl: () => false,
        readPackageTypeImpl: () => pkg,
      })
      expect(result.kind).toBe('linux-package')
      expect(result.canSelfUpdate).toBe(true)
    }
  })

  it('unrecognised package-type marker falls back to the AppImage path (mirrors electron-updater)', () => {
    const result = linux({ readPackageTypeImpl: () => 'flatpak' })
    expect(result.kind).toBe('appimage')
  })

  it('Windows — unchanged behaviour: writability of the executable directory', () => {
    const probed: string[] = []
    const writable = resolveSelfUpdateSupport({
      platform: 'win32',
      isPackaged: true,
      execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\MailCopilot\\MailCopilot.exe',
      env: {},
      isDirWritableImpl: (dir) => { probed.push(dir); return true },
    })
    expect(writable.kind).toBe('windows')
    expect(writable.canSelfUpdate).toBe(true)
    expect(probed).toHaveLength(1)

    const blocked = resolveSelfUpdateSupport({
      platform: 'win32',
      isPackaged: true,
      execPath: 'C:\\Program Files\\MailCopilot\\MailCopilot.exe',
      env: {},
      isDirWritableImpl: () => false,
    })
    expect(blocked.canSelfUpdate).toBe(false)
    expect(blocked.blockedReason).toBe('target-dir-readonly')
  })

  it('macOS — unchanged behaviour, and a stray APPIMAGE env is ignored', () => {
    const probed: string[] = []
    const result = resolveSelfUpdateSupport({
      platform: 'darwin',
      isPackaged: true,
      execPath: '/Applications/MailCopilot.app/Contents/MacOS/MailCopilot',
      env: { APPIMAGE },
      isDirWritableImpl: (dir) => { probed.push(dir); return true },
    })
    expect(result.kind).toBe('macos')
    expect(probed).toEqual(['/Applications/MailCopilot.app/Contents/MacOS'])
    expect(result.canSelfUpdate).toBe(true)
  })

  it('unpackaged (dev/e2e) — always blocked, on every platform, without probing', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
      const result = resolveSelfUpdateSupport({
        platform,
        isPackaged: false,
        execPath: '/home/user/projects/mailcopilot/node_modules/electron/dist/electron',
        env: { APPIMAGE },
        isDirWritableImpl: () => { throw new Error('must not probe when unpackaged') },
        readPackageTypeImpl: () => null,
      })
      expect(result.canSelfUpdate).toBe(false)
      expect(result.blockedReason).toBe('not-packaged')
    }
  })

  it('never leaks the target directory into the enum fields that main.ts logs', () => {
    // main.ts logs `kind` + `blockedReason` only; both must stay path-free.
    const result = linux({ isDirWritableImpl: () => false })
    expect(result.kind).not.toContain('/')
    expect(result.blockedReason ?? '').not.toContain('/')
  })
})

/**
 * The IPC boundary behind `update:download` / `update:install`.
 *
 * These tests are the reason the decision is a function instead of two inline
 * `if`s in main.ts: no unit test can import `electron/main.ts`, and e2e never
 * reaches the gate (`vite build --mode e2e` leaves `app.isPackaged === false`,
 * so both handlers short-circuit earlier). Deleting the refusal used to be
 * invisible to the whole suite.
 */
describe('§2.19 iter4 decideUpdateIpcGate', () => {
  it('refuses when packaged and self-update is known impossible', () => {
    // The deletion guard: this is the case a compromised renderer would try
    // to drive by invoking the IPC directly, past the hidden UI affordance.
    const decision = decideUpdateIpcGate({ isPackaged: true, canSelfUpdate: false })
    expect(decision.allowed).toBe(false)
    if (decision.allowed) throw new Error('unreachable — asserted above')
    expect(decision.reject).toEqual({
      ok: false,
      reason: 'permission_denied',
      error_class: 'permission',
    })
  })

  it('allows when packaged and self-update is possible', () => {
    expect(decideUpdateIpcGate({ isPackaged: true, canSelfUpdate: true })).toEqual({ allowed: true })
  })

  it('does not fire for unpackaged builds — the handlers own that short-circuit', () => {
    expect(decideUpdateIpcGate({ isPackaged: false, canSelfUpdate: false })).toEqual({ allowed: true })
    expect(decideUpdateIpcGate({ isPackaged: false, canSelfUpdate: true })).toEqual({ allowed: true })
  })

  it('rejection carries no free text — enum fields only (PII invariant)', () => {
    const decision = decideUpdateIpcGate({ isPackaged: true, canSelfUpdate: false })
    if (decision.allowed) throw new Error('expected a rejection')
    for (const value of Object.values(decision.reject)) {
      if (typeof value !== 'string') continue
      // Paths, user names and updater output all contain one of these.
      expect(value).not.toMatch(/[/\\ ]/)
    }
  })
})
