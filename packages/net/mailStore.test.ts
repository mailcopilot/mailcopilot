import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-mailstore-test-'))

// Mock the ../db module — mailStore.ts imports `dataDir` from it.
// better-sqlite3 — native module that may not load.
// Replace dataDir with a temporary directory.
vi.doMock('../db', () => {
  return { dataDir: tmpDir }
})

let mailStore!: typeof import('./mailStore')

describe('packages/net/mailStore', () => {
  beforeAll(async () => {
    mailStore = await import('./mailStore')
  })

  afterEach(() => {
    // Clean up the mail directory contents between tests
    const mailDir = path.join(tmpDir, 'mail')
    try { fs.rmSync(mailDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  afterAll(() => {
    // Remove the temp directory entirely (including if tests failed before afterEach).
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('saveEml/readEml/emlExists: writes and reads EML from disk', () => {
    const raw = Buffer.from('Subject: Test\r\n\r\nHello', 'utf8')
    mailStore.saveEml(1, 'INBOX', 42, raw)
    expect(mailStore.emlExists(1, 'INBOX', 42)).toBe(true)
    const read = mailStore.readEml(1, 'INBOX', 42)
    expect(read).not.toBeNull()
    expect(read!.toString('utf8')).toBe('Subject: Test\r\n\r\nHello')
  })

  it('readEml returns null for non-existent file', () => {
    expect(mailStore.readEml(1, 'INBOX', 999)).toBeNull()
  })

  it('emlExists returns false for non-existent file', () => {
    expect(mailStore.emlExists(1, 'INBOX', 999)).toBe(false)
  })

  it('deleteEml removes file', () => {
    const raw = Buffer.from('test', 'utf8')
    mailStore.saveEml(1, 'INBOX', 10, raw)
    expect(mailStore.emlExists(1, 'INBOX', 10)).toBe(true)
    mailStore.deleteEml(1, 'INBOX', 10)
    expect(mailStore.emlExists(1, 'INBOX', 10)).toBe(false)
  })

  it('deleteEml does not throw for non-existent file', () => {
    expect(() => mailStore.deleteEml(1, 'INBOX', 999)).not.toThrow()
  })

  it('deleteEmls removes multiple files', () => {
    const raw = Buffer.from('x', 'utf8')
    mailStore.saveEml(2, 'Sent', 1, raw)
    mailStore.saveEml(2, 'Sent', 2, raw)
    mailStore.saveEml(2, 'Sent', 3, raw)
    mailStore.deleteEmls(2, 'Sent', [1, 3])
    expect(mailStore.emlExists(2, 'Sent', 1)).toBe(false)
    expect(mailStore.emlExists(2, 'Sent', 2)).toBe(true)
    expect(mailStore.emlExists(2, 'Sent', 3)).toBe(false)
  })

  it('deleteAccountEmls removes all files for an account', () => {
    const raw = Buffer.from('data', 'utf8')
    mailStore.saveEml(5, 'INBOX', 1, raw)
    mailStore.saveEml(5, 'Sent', 2, raw)
    mailStore.saveEml(5, 'Trash', 3, raw)
    mailStore.deleteAccountEmls(5)
    expect(mailStore.emlExists(5, 'INBOX', 1)).toBe(false)
    expect(mailStore.emlExists(5, 'Sent', 2)).toBe(false)
    expect(mailStore.emlExists(5, 'Trash', 3)).toBe(false)
  })

  it('sanitizeFolder replaces special characters in folder name', () => {
    const raw = Buffer.from('ok', 'utf8')
    mailStore.saveEml(1, 'Folder/Sub', 1, raw)
    expect(mailStore.emlExists(1, 'Folder/Sub', 1)).toBe(true)
    const read = mailStore.readEml(1, 'Folder/Sub', 1)
    expect(read?.toString('utf8')).toBe('ok')
  })

  it('stores colliding legacy folder names separately', () => {
    mailStore.saveEml(1, 'Folder/Sub', 1, Buffer.from('slash', 'utf8'))
    mailStore.saveEml(1, 'Folder_Sub', 1, Buffer.from('underscore', 'utf8'))

    expect(mailStore.readEml(1, 'Folder/Sub', 1)?.toString('utf8')).toBe('slash')
    expect(mailStore.readEml(1, 'Folder_Sub', 1)?.toString('utf8')).toBe('underscore')
  })

  it('reads legacy sanitized cache paths for backward compatibility', () => {
    const legacyPath = path.join(tmpDir, 'mail', '1', 'Folder_Sub', '9.eml')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, Buffer.from('legacy', 'utf8'))

    expect(mailStore.readEml(1, 'Folder/Sub', 9)?.toString('utf8')).toBe('legacy')
    expect(mailStore.emlExists(1, 'Folder/Sub', 9)).toBe(true)
  })

  it('overwriting EML file updates content', () => {
    mailStore.saveEml(1, 'INBOX', 1, Buffer.from('v1', 'utf8'))
    expect(mailStore.readEml(1, 'INBOX', 1)?.toString('utf8')).toBe('v1')
    mailStore.saveEml(1, 'INBOX', 1, Buffer.from('v2', 'utf8'))
    expect(mailStore.readEml(1, 'INBOX', 1)?.toString('utf8')).toBe('v2')
  })

  // A write that dies part-way (crash, full disk) must not leave a truncated
  // {uid}.eml behind: the readers treat any file at that path as the cached
  // message. The spy writes half of the bytes to whatever path it is given and
  // then throws, which is what a crash mid-write leaves on disk.
  function failWriteHalfway() {
    const real = fs.writeFileSync
    return vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown) => {
      const buf = Buffer.from(data as Buffer)
      real(file, buf.subarray(0, Math.floor(buf.length / 2)))
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }) as typeof fs.writeFileSync)
  }

  it('saveEml: a write that fails part-way leaves no file and no temp file behind', () => {
    const spy = failWriteHalfway()
    try {
      expect(() => mailStore.saveEml(1, 'INBOX', 77, Buffer.from('Subject: whole message\r\n\r\nbody', 'utf8'))).toThrow(/ENOSPC/)
    } finally {
      spy.mockRestore()
    }
    expect(mailStore.emlExists(1, 'INBOX', 77)).toBe(false)
    expect(mailStore.readEml(1, 'INBOX', 77)).toBeNull()
    const dir = path.join(tmpDir, 'mail', '1', 'INBOX')
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  it('saveEml: a failed overwrite keeps the previous complete file', () => {
    mailStore.saveEml(1, 'INBOX', 78, Buffer.from('v1 complete', 'utf8'))
    const spy = failWriteHalfway()
    try {
      expect(() => mailStore.saveEml(1, 'INBOX', 78, Buffer.from('v2 that never finished', 'utf8'))).toThrow(/ENOSPC/)
    } finally {
      spy.mockRestore()
    }
    expect(mailStore.readEml(1, 'INBOX', 78)?.toString('utf8')).toBe('v1 complete')
    expect(fs.readdirSync(path.join(tmpDir, 'mail', '1', 'INBOX'))).toEqual(['78.eml'])
  })

  it('saveEml: the bytes are written to a temp file that no reader would look at, then renamed onto {uid}.eml', () => {
    const real = fs.writeFileSync
    const written: string[] = []
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: never) => {
      written.push(String(file))
      return real(file, data)
    }) as typeof fs.writeFileSync)
    try {
      mailStore.saveEml(1, 'INBOX', 79, Buffer.from('complete', 'utf8'))
    } finally {
      spy.mockRestore()
    }
    const final = path.join(tmpDir, 'mail', '1', 'INBOX', '79.eml')
    expect(written).toHaveLength(1)
    expect(written[0]).not.toBe(final)
    expect(written[0].endsWith('.eml')).toBe(false)
    expect(path.dirname(written[0])).toBe(path.dirname(final)) // same directory, so the rename is atomic
    expect(fs.readdirSync(path.dirname(final))).toEqual(['79.eml'])
  })

  it('saveEml: a failing rename removes the temp file, rethrows, and keeps the previous complete file', () => {
    mailStore.saveEml(1, 'INBOX', 80, Buffer.from('v1 complete', 'utf8'))
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    })
    try {
      expect(() => mailStore.saveEml(1, 'INBOX', 80, Buffer.from('v2 complete', 'utf8'))).toThrow(/EXDEV/)
    } finally {
      spy.mockRestore()
    }
    expect(mailStore.readEml(1, 'INBOX', 80)?.toString('utf8')).toBe('v1 complete')
    expect(fs.readdirSync(path.join(tmpDir, 'mail', '1', 'INBOX'))).toEqual(['80.eml'])
  })

  it('saveEml: two overwrites interleaved at the rename do not share a temp file, and the last rename wins whole', () => {
    // A second save of the same message runs between the first one's write and its rename (two sync
    // runs, or two processes on one profile). With one fixed temp name the inner rename would take the
    // outer's file away and the outer rename would fail.
    const realRename = fs.renameSync
    let nested = false
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!nested) {
        nested = true
        mailStore.saveEml(1, 'INBOX', 81, Buffer.from('inner message', 'utf8'))
      }
      return realRename(from, to)
    }) as typeof fs.renameSync)
    try {
      mailStore.saveEml(1, 'INBOX', 81, Buffer.from('outer message', 'utf8'))
    } finally {
      spy.mockRestore()
    }
    expect(mailStore.readEml(1, 'INBOX', 81)?.toString('utf8')).toBe('outer message')
    expect(fs.readdirSync(path.join(tmpDir, 'mail', '1', 'INBOX'))).toEqual(['81.eml'])
  })

  // A process killed between the temp write and the rename leaves the temp
  // file, which holds the message body. Deleting the message removes it too.
  function plantOrphanTemp(uid: number): string {
    const dir = path.join(tmpDir, 'mail', '1', 'INBOX')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, `.${uid}.eml.4242.0a1b2c3d4e5f.tmp`)
    fs.writeFileSync(p, 'Subject: secret body')
    return p
  }

  it('deleteEml also removes a temp file orphaned by a killed write of that message', () => {
    mailStore.saveEml(1, 'INBOX', 90, Buffer.from('v1', 'utf8'))
    const orphan = plantOrphanTemp(90)
    const other = plantOrphanTemp(91)
    mailStore.deleteEml(1, 'INBOX', 90)
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
    expect(mailStore.emlExists(1, 'INBOX', 90)).toBe(false)
  })

  it('deleteEmls removes the orphaned temp files of every deleted message and no others', () => {
    const a = plantOrphanTemp(92)
    const b = plantOrphanTemp(93)
    const keep = plantOrphanTemp(920)
    mailStore.deleteEmls(1, 'INBOX', [92, 93])
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('files of different accounts are isolated', () => {
    const raw = Buffer.from('test', 'utf8')
    mailStore.saveEml(1, 'INBOX', 1, raw)
    mailStore.saveEml(2, 'INBOX', 1, raw)
    mailStore.deleteAccountEmls(1)
    // Account 2 is not affected
    expect(mailStore.emlExists(2, 'INBOX', 1)).toBe(true)
  })
})
