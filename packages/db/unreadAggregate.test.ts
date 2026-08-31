import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

let betterSqlite3Usable = true
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function loadDbModule(): Promise<{ dir: string; mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-unread-agg-test-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  const mod = await import('./index')
  return { dir, mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule, prevDataDir: string | undefined) {
  try { mod.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

function key(row: { accountId: number; folder: string }): string {
  return `${row.accountId}:${row.folder}`
}

describe('packages/db countUnreadByFolder (§2.99)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('groups unread across every account and folder, skipping empty buckets', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'a', fromAddr: 'a@example.test', date: '2026-02-08T00:00:00.000Z', unread: true },
        { uid: 2, subject: 'b', fromAddr: 'b@example.test', date: '2026-02-08T00:01:00.000Z', unread: true },
        { uid: 3, subject: 'c', fromAddr: 'c@example.test', date: '2026-02-08T00:02:00.000Z', unread: false },
      ])
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 'junk', fromAddr: 'x@example.test', date: '2026-02-08T00:03:00.000Z', unread: true },
      ])
      // Fully-read folder must not appear at all.
      mod.upsertMessages(1, 'Sent', [
        { uid: 1, subject: 'sent', fromAddr: 'me@example.test', date: '2026-02-08T00:04:00.000Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 7, subject: 'other account', fromAddr: 'd@example.test', date: '2026-02-08T00:05:00.000Z', unread: true },
      ])

      const rows = mod.countUnreadByFolder()
      const byKey = new Map(rows.map(r => [key(r), r.unread]))
      expect(byKey.get('1:INBOX')).toBe(2)
      expect(byKey.get('1:Spam')).toBe(1)
      expect(byKey.get('2:INBOX')).toBe(1)
      expect(byKey.has('1:Sent')).toBe(false)
      expect(rows).toHaveLength(3)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('excludes snoozed messages, exactly like countUnreadMessages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 10, subject: 'a', fromAddr: 'a@example.test', date: '2026-02-08T00:00:00.000Z', unread: true },
        { uid: 11, subject: 'b', fromAddr: 'b@example.test', date: '2026-02-08T00:01:00.000Z', unread: true },
      ])
      mod.insertSnooze(1, null, 'INBOX', 11, '2026-03-01T10:00:00Z')

      const rows = mod.countUnreadByFolder()
      expect(rows).toEqual([{ accountId: 1, folder: 'INBOX', unread: 1 }])
      expect(rows[0].unread).toBe(mod.countUnreadMessages(1, 'INBOX'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('returns an empty list when nothing is unread', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.countUnreadByFolder()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
