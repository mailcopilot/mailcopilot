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

  it('files of different accounts are isolated', () => {
    const raw = Buffer.from('test', 'utf8')
    mailStore.saveEml(1, 'INBOX', 1, raw)
    mailStore.saveEml(2, 'INBOX', 1, raw)
    mailStore.deleteAccountEmls(1)
    // Account 2 is not affected
    expect(mailStore.emlExists(2, 'INBOX', 1)).toBe(true)
  })
})
