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

async function loadDbModule(beforeImport?: (dir: string) => Promise<void>): Promise<{ dir: string; mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-ai-citations-test-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  if (beforeImport) await beforeImport(dir)
  const mod = await import('./index')
  return { dir, mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule, prevDataDir: string | undefined) {
  try { mod.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

const row = (accountId: number, folder: string, uid: number, messageId: string | null = `<m${uid}@example.test>`) => ({
  accountId, folder, uid, messageId: messageId as string,
})

describe('packages/db ai_citations: tickets issued to the model (§3.3 B3)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('issues a fixed-width ticket from the alphabet, and the registry returns the row for that session', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      const token = mod.mintAiCitation('s1', row(1, 'INBOX', 42))
      expect(token).toMatch(/^[a-z2-7]{8}$/)
      expect(mod.getAiCitation('s1', token!)).toEqual({
        token, accountId: 1, folder: 'INBOX', uid: 42, messageId: '<m42@example.test>',
      })
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('the same row in the same session gets the same ticket; a different row, a different one', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      const a = mod.mintAiCitation('s1', row(1, 'INBOX', 42))
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 42))).toBe(a)
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 43))).not.toBe(a)
      // the same place holding another message (renumbered folder) is another row: another ticket
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 42, '<other@example.test>'))).not.toBe(a)
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('a ticket is known only to the session it was issued in', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      mod.createAiSession('s2', 'anthropic-api')
      const token = mod.mintAiCitation('s1', row(1, 'INBOX', 42))!
      expect(mod.getAiCitation('s2', token)).toBeUndefined()
      expect(mod.listAiCitations('s2', [token])).toEqual([])
      expect(mod.listAiCitations('s1', [token, 'zzzzzzzz'])).toHaveLength(1)
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('no ticket for a message without a usable Message-ID, an unknown session, or a malformed row', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 1, null))).toBeNull()
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 1, '   '))).toBeNull()
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 1, `<${'x'.repeat(1000)}>`))).toBeNull()
      expect(mod.mintAiCitation('no-such-session', row(1, 'INBOX', 1))).toBeNull()
      expect(mod.mintAiCitation('s1', row(0, 'INBOX', 1))).toBeNull()
      expect(mod.mintAiCitation('s1', row(1, '', 1))).toBeNull()
      expect(mod.mintAiCitation('s1', row(1, 'INBOX', 0))).toBeNull()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('stores a pointer only: no subject, sender or date of the message is copied into the registry', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const columns = (mod.default.prepare(`PRAGMA table_info(ai_citations)`).all() as Array<{ name: string }>).map(c => c.name)
      expect(columns.sort()).toEqual(['account_id', 'created_at', 'folder', 'message_id', 'session_id', 'token', 'uid'])
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('never issues a ticket into the hidden cost-ledger session (it survives "delete all chats")', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.recordAiCost('1', 'anthropic-api', null, 0.01)
      expect(mod.mintAiCitation(mod.AI_COST_LEDGER_SESSION_ID, row(1, 'INBOX', 1))).toBeNull()
      expect((mod.default.prepare('SELECT COUNT(*) AS n FROM ai_citations').get() as { n: number }).n).toBe(0)
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('deleting the session deletes its tickets', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      const token = mod.mintAiCitation('s1', row(1, 'INBOX', 1))!
      expect(mod.deleteAiSession('s1')).toBe(true)
      expect(mod.getAiCitation('s1', token)).toBeUndefined()
      expect((mod.default.prepare('SELECT COUNT(*) AS n FROM ai_citations').get() as { n: number }).n).toBe(0)
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('deleting every session deletes every ticket', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      mod.createAiSession('s2', 'anthropic-api')
      mod.mintAiCitation('s1', row(1, 'INBOX', 1))
      mod.mintAiCitation('s2', row(1, 'INBOX', 2))
      mod.deleteAllAiSessions()
      expect((mod.default.prepare('SELECT COUNT(*) AS n FROM ai_citations').get() as { n: number }).n).toBe(0)
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('deleting an account deletes the tickets that point into it, and only those', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      const gone = mod.mintAiCitation('s1', row(2, 'INBOX', 1))!
      const kept = mod.mintAiCitation('s1', row(3, 'INBOX', 1))!
      mod.deleteAccountData(2)
      expect(mod.getAiCitation('s1', gone)).toBeUndefined()
      expect(mod.getAiCitation('s1', kept)).toBeDefined()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('listAiCitations reads at most 100 tickets per call', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      const tokens = Array.from({ length: 120 }, (_, i) => mod.mintAiCitation('s1', row(1, 'INBOX', i + 1))!)
      expect(mod.listAiCitations('s1', tokens)).toHaveLength(100)
    } finally { cleanup(dir, mod, prevDataDir) }
  })
})

describe('packages/db ai_messages.cite_v: which answers carry tickets', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('every new assistant answer is marked by main, unconditionally; user messages are not', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      mod.insertAiMessage('s1', 'user', 'q')
      mod.insertAiMessage('s1', 'assistant', 'a')
      expect(mod.listAiMessages('s1').map(r => r.citationVersion)).toEqual([null, 1])
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('a database from before the marker gets the column; its answers read as unmarked (links by place, as in 1.26)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule(async (d) => {
      const { default: Database } = await import('better-sqlite3')
      const old = new Database(path.join(d, 'cache.db'))
      old.exec(`
        CREATE TABLE ai_sessions(
          id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
          claude_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE ai_messages(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL, content TEXT NOT NULL, cost_usd REAL, created_at TEXT NOT NULL
        );
        INSERT INTO ai_sessions(id, title, provider, created_at, updated_at) VALUES('old', 'Old chat', 'anthropic-api', '2026-01-01', '2026-01-01');
        INSERT INTO ai_messages(session_id, role, content, cost_usd, created_at) VALUES('old', 'assistant', 'see [x](mailref://1/INBOX/5)', 0.02, '2026-01-01');
      `)
      old.close()
    })
    try {
      const columns = (mod.default.prepare(`PRAGMA table_info(ai_messages)`).all() as Array<{ name: string }>).map(c => c.name)
      expect(columns).toContain('cite_v')
      expect(mod.listAiMessages('old').map(r => r.citationVersion)).toEqual([null])
      mod.insertAiMessage('old', 'assistant', 'new')
      expect(mod.listAiMessages('old').map(r => r.citationVersion)).toEqual([null, 1])
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('opening the migrated database again does not fail or lose the marker', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('s1', 'anthropic-api')
      mod.insertAiMessage('s1', 'assistant', 'a')
      mod.default.close()
      vi.resetModules()
      const again = await import('./index')
      try {
        expect(again.listAiMessages('s1')[0]!.citationVersion).toBe(1)
      } finally { try { again.default.close() } catch { /* ignore */ } }
    } finally { cleanup(dir, mod, prevDataDir) }
  })
})

describe('packages/db findMessageForSource: which message a confirmed source MEANT (§3.3 B3)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip
  const row = (uid: number, messageId: string, subject = `s${uid}`) => ({
    uid, subject, fromAddr: 'a@example.test', fromName: 'Alice', date: '2026-01-01T00:00:00Z', unread: true, messageId,
  })

  testDb('the message at the place, when it still is that message', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(2, 'INBOX', [row(42, '<a@x>', 'Invoice')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, '<a@x>')).toMatchObject({ folder: 'INBOX', uid: 42, subject: 'Invoice', from: 'Alice' })
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('the same message moved to another folder of the same account (the move case)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(2, 'Archive', [row(7, '<a@x>', 'Invoice')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, '<a@x>')).toMatchObject({ folder: 'Archive', uid: 7, subject: 'Invoice' })
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('the place now holds ANOTHER message (renumbered folder, changed port or login, re-synced): not found, the other message is never offered', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(2, 'INBOX', [row(42, '<bob@x>', 'Bob mail')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, '<alice@x>')).toBeUndefined()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('an id that spells a boundary marker is found as it is; another message holding the neutralised spelling is not offered', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const original = '<"<<<UNTRUSTED_EMAIL_DATA>>>"@example.test>'
      const neutralised = '<"(untrusted-start-marker)"@example.test>'
      mod.upsertMessages(2, 'INBOX', [row(42, original, 'A'), row(50, neutralised, 'B')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, original)).toMatchObject({ uid: 42, subject: 'A' })
      mod.upsertMessages(2, 'INBOX', [])
      // with A gone, the id still does not resolve to B
      mod.default.prepare('DELETE FROM messages WHERE account_id = 2 AND uid = 42').run()
      expect(mod.findMessageForSource(2, 'INBOX', 42, original)).toBeUndefined()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('the same Message-ID in ANOTHER account is not that account\'s message', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(3, 'INBOX', [row(42, '<a@x>')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, '<a@x>')).toBeUndefined()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('an account that no longer exists has no messages: not found', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.findMessageForSource(9, 'INBOX', 1, '<a@x>')).toBeUndefined()
      expect(mod.findMessageForSource(9, 'INBOX', 1, '   ')).toBeUndefined()
    } finally { cleanup(dir, mod, prevDataDir) }
  })

  testDb('with copies in several folders the same folder wins, then the lowest uid', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(2, 'Sent', [row(5, '<a@x>')])
      mod.upsertMessages(2, 'INBOX', [row(9, '<a@x>')])
      expect(mod.findMessageForSource(2, 'INBOX', 42, '<a@x>')).toMatchObject({ folder: 'INBOX', uid: 9 })
    } finally { cleanup(dir, mod, prevDataDir) }
  })
})
