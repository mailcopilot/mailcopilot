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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-followup-test-'))
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

describe('packages/db follow-up reminders', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('insertFollowUp + listFollowUps', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-abc', 'Sent', null, 'bob@example.com', 'Re: Hello', '2026-03-01T10:00:00Z')
      expect(id).toBeGreaterThan(0)

      const list = mod.listFollowUps(1)
      expect(list).toHaveLength(1)
      expect(list[0].accountId).toBe(1)
      expect(list[0].sentMessageId).toBe('msg-abc')
      expect(list[0].folder).toBe('Sent')
      expect(list[0].toAddr).toBe('bob@example.com')
      expect(list[0].subject).toBe('Re: Hello')
      expect(list[0].remindAt).toBe('2026-03-01T10:00:00Z')
      expect(list[0].status).toBe('pending')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeFollowUp deletes by id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-1', 'Sent', 10, 'a@b.c', undefined, '2026-03-01T10:00:00Z')
      expect(mod.listFollowUps(1)).toHaveLength(1)

      const ok = mod.removeFollowUp(id)
      expect(ok).toBe(true)
      expect(mod.listFollowUps(1)).toHaveLength(0)

      // Repeated deletion — false
      expect(mod.removeFollowUp(id)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listFollowUps filters by accountId', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Subj 1', '2026-03-01T10:00:00Z')
      mod.insertFollowUp(2, 'msg-2', 'Sent', null, 'x@y.z', 'Subj 2', '2026-03-02T10:00:00Z')

      expect(mod.listFollowUps(1)).toHaveLength(1)
      expect(mod.listFollowUps(2)).toHaveLength(1)
      expect(mod.listFollowUps(99)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listFollowUps without accountId returns all pending and notified', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id1 = mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'S1', '2026-03-01T10:00:00Z')
      mod.insertFollowUp(2, 'msg-2', 'Sent', null, 'x@y.z', 'S2', '2026-03-02T10:00:00Z')

      // Mark one as notified — should remain in the list
      mod.markFollowUpNotified(id1)

      const all = mod.listFollowUps()
      expect(all).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listDueFollowUps returns overdue follow-ups', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Old', '2026-02-01T00:00:00Z') // overdue
      mod.insertFollowUp(1, 'msg-2', 'Sent', null, 'b@c.d', 'Future', '2026-12-31T23:59:59Z') // future

      const due = mod.listDueFollowUps('2026-06-01T00:00:00Z')
      expect(due).toHaveLength(1)
      expect(due[0].toAddr).toBe('a@b.c')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('dismissFollowUp changes status to dismissed', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Test', '2026-03-01T10:00:00Z')

      const ok = mod.dismissFollowUp(id)
      expect(ok).toBe(true)

      // After dismiss should not be in the pending list
      expect(mod.listFollowUps(1)).toHaveLength(0)

      // Repeated dismiss — true (UPDATE does not check previous status)
      // but won't appear in listDueFollowUps anymore
      expect(mod.listDueFollowUps('2026-12-31T00:00:00Z')).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('markFollowUpNotified changes status to notified (no repeat notifications)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Test', '2026-03-01T10:00:00Z')

      const ok = mod.markFollowUpNotified(id)
      expect(ok).toBe(true)

      // After notified — should not be in listDueFollowUps (only pending)
      expect(mod.listDueFollowUps('2026-12-31T00:00:00Z')).toHaveLength(0)

      // But should be in listFollowUps (shown in UI)
      expect(mod.listFollowUps(1)).toHaveLength(1)
      expect(mod.listFollowUps(1)[0].status).toBe('notified')

      // Repeated call — false (no longer pending)
      expect(mod.markFollowUpNotified(id)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('markFollowUpAnswered changes status to answered', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Test', '2026-03-01T10:00:00Z')

      const ok = mod.markFollowUpAnswered(id)
      expect(ok).toBe(true)

      // After answered should not be in the pending list
      expect(mod.listFollowUps(1)).toHaveLength(0)
      expect(mod.listDueFollowUps('2026-12-31T00:00:00Z')).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAccountData deletes follow-ups for an account', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Test', '2026-03-01T10:00:00Z')
      mod.insertFollowUp(2, 'msg-2', 'Sent', null, 'x@y.z', 'Test2', '2026-03-02T10:00:00Z')

      mod.deleteAccountData(1)

      expect(mod.listFollowUps(1)).toHaveLength(0)
      expect(mod.listFollowUps(2)).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('insertFollowUp with uid=null', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', undefined, '2026-03-01T10:00:00Z')
      const list = mod.listFollowUps(1)
      expect(list[0].uid).toBeNull()
      expect(list[0].subject).toBeNull()
      expect(id).toBeGreaterThan(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listFollowUps returns results sorted by remind_at ASC', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertFollowUp(1, 'msg-2', 'Sent', null, 'b@c.d', 'Late', '2026-05-01T10:00:00Z')
      mod.insertFollowUp(1, 'msg-1', 'Sent', null, 'a@b.c', 'Early', '2026-03-01T10:00:00Z')

      const list = mod.listFollowUps(1)
      expect(list).toHaveLength(2)
      expect(list[0].subject).toBe('Early')
      expect(list[1].subject).toBe('Late')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
