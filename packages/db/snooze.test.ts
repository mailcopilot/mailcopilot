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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-snooze-test-'))
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

describe('packages/db snooze', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('insertSnooze + listSnoozed', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertSnooze(1, 'msg-1', 'INBOX', 42, '2026-03-01T10:00:00Z')
      expect(id).toBeGreaterThan(0)

      const list = mod.listSnoozed(1)
      expect(list).toHaveLength(1)
      expect(list[0].accountId).toBe(1)
      expect(list[0].folder).toBe('INBOX')
      expect(list[0].uid).toBe(42)
      expect(list[0].wakeAt).toBe('2026-03-01T10:00:00Z')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeSnooze deletes by id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = mod.insertSnooze(1, null, 'INBOX', 10, '2026-03-01T10:00:00Z')
      expect(mod.listSnoozed(1)).toHaveLength(1)

      const ok = mod.removeSnooze(id)
      expect(ok).toBe(true)
      expect(mod.listSnoozed(1)).toHaveLength(0)

      // Repeated deletion — false
      expect(mod.removeSnooze(id)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeSnoozeByUid deletes by accountId+folder+uid', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertSnooze(1, null, 'INBOX', 5, '2026-03-01T10:00:00Z')
      mod.insertSnooze(1, null, 'INBOX', 6, '2026-03-02T10:00:00Z')

      const ok = mod.removeSnoozeByUid(1, 'INBOX', 5)
      expect(ok).toBe(true)
      expect(mod.listSnoozed(1)).toHaveLength(1)
      expect(mod.listSnoozed(1)[0].uid).toBe(6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listAllSnoozedUids returns folder+uid pairs', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertSnooze(1, null, 'INBOX', 1, '2026-03-01T10:00:00Z')
      mod.insertSnooze(1, null, 'Sent', 2, '2026-03-02T10:00:00Z')
      mod.insertSnooze(2, null, 'INBOX', 3, '2026-03-03T10:00:00Z')

      const uids = mod.listAllSnoozedUids(1)
      expect(uids).toHaveLength(2)
      expect(uids).toEqual(expect.arrayContaining([
        { folder: 'INBOX', uid: 1 },
        { folder: 'Sent', uid: 2 },
      ]))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listDueSnooze returns overdue snoozes', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertSnooze(1, null, 'INBOX', 1, '2026-02-01T00:00:00Z') // overdue
      mod.insertSnooze(1, null, 'INBOX', 2, '2026-12-31T23:59:59Z') // future

      const due = mod.listDueSnooze('2026-06-01T00:00:00Z')
      expect(due).toHaveLength(1)
      expect(due[0].uid).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listSnoozed does not mix accounts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.insertSnooze(1, null, 'INBOX', 1, '2026-03-01T10:00:00Z')
      mod.insertSnooze(2, null, 'INBOX', 2, '2026-03-02T10:00:00Z')

      expect(mod.listSnoozed(1)).toHaveLength(1)
      expect(mod.listSnoozed(2)).toHaveLength(1)
      expect(mod.listSnoozed(99)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getMessages excludes snoozed messages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Add 3 messages
      mod.upsertMessages(1, 'INBOX', [{
        uid: 10, subject: 'Normal', fromAddr: 'a@b.com', fromName: '',
        toAddr: '', messageId: 'msg-normal', inReplyTo: '', references: '',
        date: '2026-01-01T00:00:00Z', unread: true, flagged: false, hasAttachments: false,
      }])
      mod.upsertMessages(1, 'INBOX', [{
        uid: 20, subject: 'Snoozed', fromAddr: 'c@d.com', fromName: '',
        toAddr: '', messageId: 'msg-snoozed', inReplyTo: '', references: '',
        date: '2026-01-02T00:00:00Z', unread: true, flagged: false, hasAttachments: false,
      }])
      mod.upsertMessages(1, 'INBOX', [{
        uid: 30, subject: 'Also normal', fromAddr: 'e@f.com', fromName: '',
        toAddr: '', messageId: 'msg-normal2', inReplyTo: '', references: '',
        date: '2026-01-03T00:00:00Z', unread: false, flagged: false, hasAttachments: false,
      }])

      // Without snooze — all 3 messages visible
      expect(mod.getMessages(1, 'INBOX')).toHaveLength(3)

      // Snooze uid=20
      mod.insertSnooze(1, 'msg-snoozed', 'INBOX', 20, '2026-12-01T00:00:00Z')

      // Now getMessages returns only 2 messages (uid 10 and 30)
      const msgs = mod.getMessages(1, 'INBOX')
      expect(msgs).toHaveLength(2)
      expect(msgs.map(m => m.uid).sort()).toEqual([10, 30])

      // getMessagesBeforeUid also filters
      const before = mod.getMessagesBeforeUid(1, 'INBOX', 100, 31)
      expect(before).toHaveLength(2)
      expect(before.map(m => m.uid).sort()).toEqual([10, 30])

      // After removing snooze — message is visible again
      mod.removeSnoozeByUid(1, 'INBOX', 20)
      expect(mod.getMessages(1, 'INBOX')).toHaveLength(3)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUnifiedInboxPage excludes snoozed messages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [{
        uid: 10, subject: 'Visible', fromAddr: 'a@b.com', fromName: '',
        toAddr: '', messageId: 'msg-v', inReplyTo: '', references: '',
        date: '2026-01-01T00:00:00Z', unread: true, flagged: false, hasAttachments: false,
      }])
      mod.upsertMessages(2, 'INBOX', [{
        uid: 20, subject: 'Snoozed in unified', fromAddr: 'c@d.com', fromName: '',
        toAddr: '', messageId: 'msg-s', inReplyTo: '', references: '',
        date: '2026-01-02T00:00:00Z', unread: true, flagged: false, hasAttachments: false,
      }])

      expect(mod.getUnifiedInboxPage([1, 2])).toHaveLength(2)

      mod.insertSnooze(2, 'msg-s', 'INBOX', 20, '2026-12-01T00:00:00Z')

      const unified = mod.getUnifiedInboxPage([1, 2])
      expect(unified).toHaveLength(1)
      expect(unified[0].uid).toBe(10)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
