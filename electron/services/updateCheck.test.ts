import { describe, it, expect, afterEach } from 'vitest'
import { canWriteAppDir } from './updateCheck'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('canWriteAppDir', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  it('returns true when directory is writable', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'))
    const fakeExec = path.join(tmpDir, 'app')
    expect(canWriteAppDir(fakeExec)).toBe(true)
  })

  // Root ignores filesystem permission bits, so this test only works for non-root users.
  it.skipIf(process.getuid?.() === 0)('returns false when directory is read-only', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'))
    fs.chmodSync(tmpDir, 0o555)
    const fakeExec = path.join(tmpDir, 'app')
    expect(canWriteAppDir(fakeExec)).toBe(false)
    // Restore permissions so cleanup works
    fs.chmodSync(tmpDir, 0o755)
  })

  it('returns false when directory does not exist', () => {
    expect(canWriteAppDir('/nonexistent-path-12345/app')).toBe(false)
  })
})
