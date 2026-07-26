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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-notif-test-'))
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

describe('packages/db notifications', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('insertNotification + listNotifications', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertNotification('followup_due', 'Re: Hello', 'bob@example.com', '42')
      expect(id).toBeGreaterThan(0)

      const list = mod.listNotifications()
      expect(list).toHaveLength(1)
      expect(list[0].type).toBe('followup_due')
      expect(list[0].title).toBe('Re: Hello')
      expect(list[0].body).toBe('bob@example.com')
      expect(list[0].refId).toBe('42')
      expect(list[0].read).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('countUnreadNotifications', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertNotification('followup_due', 'Test 1', '')
      mod.insertNotification('send_failed', 'Test 2', 'error')

      expect(mod.countUnreadNotifications()).toBe(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('markNotificationRead', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertNotification('followup_due', 'Test', '')
      expect(mod.countUnreadNotifications()).toBe(1)

      mod.markNotificationRead(id)
      expect(mod.countUnreadNotifications()).toBe(0)

      const list = mod.listNotifications()
      expect(list[0].read).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('markAllNotificationsRead', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertNotification('followup_due', 'A', '')
      mod.insertNotification('send_failed', 'B', '')
      mod.insertNotification('followup_due', 'C', '')

      expect(mod.countUnreadNotifications()).toBe(3)
      const count = mod.markAllNotificationsRead()
      expect(count).toBe(3)
      expect(mod.countUnreadNotifications()).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteNotification', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertNotification('followup_due', 'Test', '')
      expect(mod.listNotifications()).toHaveLength(1)

      const deleted = mod.deleteNotification(id)
      expect(deleted).toBe(true)
      expect(mod.listNotifications()).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('purgeOldNotifications', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Insert a notification, then manually backdate it
      mod.insertNotification('followup_due', 'Old', '')
      mod.insertNotification('followup_due', 'New', '')

      // Backdate the first one via raw SQL
      const db = mod.default
      const old = mod.listNotifications()
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString()
      db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(oldDate, old[1].id) // oldest (list is DESC)

      const purged = mod.purgeOldNotifications(30)
      expect(purged).toBe(1)
      expect(mod.listNotifications()).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listNotifications respects limit', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 10; i++) {
        mod.insertNotification('followup_due', `Notif ${i}`, '')
      }
      const limited = mod.listNotifications(3)
      expect(limited).toHaveLength(3)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('insertNotification without refId defaults to null', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertNotification('send_failed', 'Failed', 'SMTP error')
      const list = mod.listNotifications()
      expect(list[0].refId).toBeNull()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
