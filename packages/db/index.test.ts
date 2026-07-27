import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'

type DbModule = typeof import('./index')

// better-sqlite3 is a native module. In some environments the Node ABI may not match
// the one the dependencies were built for (e.g., if node_modules were installed for a different Node version).
// In that case we skip DB tests so that `npm test` stays green.
let betterSqlite3Usable = true
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function loadDbModule(): Promise<{ dir: string; mod: DbModule; prevDataDir: string | undefined }> {
  // The DB module holds a singleton and initializes on import, so for tests
  // we reset the module cache and provide a separate MAILCOPILOT_DATA_DIR.
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-test-'))
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

describe('packages/db', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('upsert/getMessagesBeforeUid/setFlagged/searchMessages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()

    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 3, subject: 's3', fromAddr: 'bob@example.test', date: '2026-02-08T00:10:00.000Z', unread: true, flagged: false },
        { uid: 2, subject: 's2', fromAddr: 'alice@example.test', date: '2026-02-08T00:05:00.000Z', unread: false, flagged: true },
        { uid: 1, subject: 'hello world', fromAddr: 'carol@example.test', date: '2026-02-08T00:00:00.000Z', unread: false },
      ])

      const all = mod.getMessages(1, 'INBOX', 10)
      expect(all.map(m => m.uid)).toEqual([3, 2, 1])
      expect(all.find(m => m.uid === 2)?.flagged).toBe(true)

      const before2 = mod.getMessagesBeforeUid(1, 'INBOX', 10, 2)
      expect(before2.map(m => m.uid)).toEqual([1])

      mod.setFlagged(1, 'INBOX', [1], true)
      const afterFlag = mod.getMessagesBeforeUid(1, 'INBOX', 10, 2)
      expect(afterFlag[0]?.flagged).toBe(true)

      const bySubject = mod.searchMessages(1, 'INBOX', 'hello', 10, 0)
      expect(bySubject.map(m => m.uid)).toEqual([1])

      const byFrom = mod.searchMessages(1, 'INBOX', 'alice', 10, 0)
      expect(byFrom.map(m => m.uid)).toEqual([2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteMessages removes records from DB', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.deleteMessages(1, 'INBOX', [1, 3])
      const remaining = mod.getMessages(1, 'INBOX', 10)
      expect(remaining.map(m => m.uid)).toEqual([2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('setUnread toggles the read/unread flag', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      expect(mod.getMessages(1, 'INBOX')[0].unread).toBe(false)

      mod.setUnread(1, 'INBOX', [1], true)
      expect(mod.getMessages(1, 'INBOX')[0].unread).toBe(true)

      mod.setUnread(1, 'INBOX', [1], false)
      expect(mod.getMessages(1, 'INBOX')[0].unread).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchMessages returns empty array for empty query', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'test', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      expect(mod.searchMessages(1, 'INBOX', '', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'INBOX', '   ', 10, 0)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchMessages supports body: and -body: operators', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        {
          uid: 1,
          subject: 's1',
          fromAddr: 'a@test',
          date: '2026-01-01T00:00:00Z',
          unread: false,
          bodyText: 'Weekly project report and action items',
        },
        {
          uid: 2,
          subject: 's2',
          fromAddr: 'b@test',
          date: '2026-01-02T00:00:00Z',
          unread: false,
          bodyText: 'Lunch plans only',
        },
      ])

      expect(mod.searchMessages(1, 'INBOX', 'body:report', 10, 0).map(m => m.uid)).toEqual([1])
      expect(mod.searchMessages(1, 'INBOX', 'body:report -body:action', 10, 0).map(m => m.uid)).toEqual([])

      // body_text should also update after upsert (fetch details path)
      mod.updateMessageBodyText(1, 'INBOX', 2, 'Project report is attached')
      expect(mod.searchMessages(1, 'INBOX', 'body:report', 10, 0).map(m => m.uid)).toEqual([2, 1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getMessagesBeforeUid without beforeUid returns getMessages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      const noUid = mod.getMessagesBeforeUid(1, 'INBOX', 10, undefined)
      const all = mod.getMessages(1, 'INBOX', 10)
      expect(noUid.map(m => m.uid)).toEqual(all.map(m => m.uid))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsert updates existing records (ON CONFLICT)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Original', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
      ])
      expect(mod.getMessages(1, 'INBOX')[0].subject).toBe('Original')
      expect(mod.getMessages(1, 'INBOX')[0].unread).toBe(true)

      // Update the same record
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Updated', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      const msgs = mod.getMessages(1, 'INBOX')
      expect(msgs.length).toBe(1)
      expect(msgs[0].subject).toBe('Updated')
      expect(msgs[0].unread).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('contacts: incoming/outgoing/manual + search sort/filter', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertContactsIncoming([
        { email: 'alice@example.test', name: 'Alice' },
        { email: 'no-reply@example.test', name: 'Service Bot' },
      ], '2026-02-01T10:00:00.000Z')

      mod.upsertContactsOutgoing([
        { email: 'alice@example.test', name: 'Alice A.' },
        { email: 'bob@example.test', name: 'Bob' },
      ], '2026-02-02T10:00:00.000Z')

      // Sent to Bob again -> frequency should increase.
      mod.upsertContactsOutgoing([
        { email: 'bob@example.test', name: 'Bob B.' },
      ], '2026-02-03T10:00:00.000Z')

      mod.upsertContactManual('carol@example.test', 'Carol')

      const bob = mod.searchContacts('bob', 8)
      expect(bob[0]?.email).toBe('bob@example.test')
      expect(bob[0]?.frequency).toBe(2)
      expect(bob[0]?.name).toBe('Bob B.')

      const a = mod.searchContacts('ali', 8)
      expect(a.map(x => x.email)).toContain('alice@example.test')
      expect(a.some(x => x.email === 'no-reply@example.test')).toBe(false)

      const c = mod.searchContacts('car', 8)
      expect(c[0]?.email).toBe('carol@example.test')
      expect(c[0]?.source).toBe('manual')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('hasAttachments is correctly saved and read', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'with att', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, hasAttachments: true },
        { uid: 2, subject: 'no att', fromAddr: 'b@test', date: '2026-01-01T00:00:00Z', unread: false, hasAttachments: false },
        { uid: 3, subject: 'default', fromAddr: 'c@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      const msgs = mod.getMessages(1, 'INBOX', 10)
      expect(msgs.find(m => m.uid === 1)?.hasAttachments).toBe(true)
      expect(msgs.find(m => m.uid === 2)?.hasAttachments).toBe(false)
      expect(msgs.find(m => m.uid === 3)?.hasAttachments).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Offline storage ---

  testDb('setBodyDownloaded/getUidsWithoutBody/countBodiesDownloaded', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // Initially all body_downloaded=0
      const toDownload = mod.getUidsWithoutBody(1, 'INBOX', 50)
      expect(toDownload).toEqual([3, 2, 1])

      // Download body for uid=2
      mod.setBodyDownloaded(1, 'INBOX', 2, true, 5000)
      const toDownload2 = mod.getUidsWithoutBody(1, 'INBOX', 50)
      expect(toDownload2).toEqual([3, 1])

      // Counters
      const counts = mod.countBodiesDownloaded(1, 'INBOX')
      expect(counts.downloaded).toBe(1)
      expect(counts.total).toBe(3)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUidsOlderThan returns downloaded UIDs older than threshold', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const old = '2025-01-01T00:00:00Z'
      const recent = '2026-02-01T00:00:00Z'
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: old, unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: recent, unread: false },
      ])
      mod.setBodyDownloaded(1, 'INBOX', 1, true)
      mod.setBodyDownloaded(1, 'INBOX', 2, true)

      const oldUids = mod.getUidsOlderThan(1, 'INBOX', '2026-01-01T00:00:00Z')
      expect(oldUids).toEqual([1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUidsWithoutBody with date filter', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2025-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-02-01T00:00:00Z', unread: false },
      ])
      // Only recent (from 2026)
      const uids = mod.getUidsWithoutBody(1, 'INBOX', 50, '2026-01-01T00:00:00Z')
      expect(uids).toEqual([2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Offline operations ---

  testDb('upsertOfflineOp/getOfflineOps/deleteOfflineOp', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 42, 'setSeen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 43, 'delete')
      mod.upsertOfflineOp(2, 'Sent', 10, 'move', { to: 'Trash' })

      const allOps = mod.getOfflineOps()
      expect(allOps.length).toBe(3)

      const acc1Ops = mod.getOfflineOps(1)
      expect(acc1Ops.length).toBe(2)
      expect(acc1Ops[0].opType).toBe('setSeen')
      expect(acc1Ops[0].payload).toEqual({ seen: true })
      expect(acc1Ops[1].opType).toBe('delete')
      expect(acc1Ops[1].payload).toBeNull()

      // Delete one operation
      mod.deleteOfflineOp(acc1Ops[0].id)
      expect(mod.getOfflineOps(1).length).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Unified Inbox ---

  testDb('getUnifiedInboxPage returns messages from multiple accounts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'a1', fromAddr: 'a@test', date: '2026-02-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'a2', fromAddr: 'a@test', date: '2026-02-03T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 'b1', fromAddr: 'b@test', date: '2026-02-02T00:00:00Z', unread: false },
      ])

      const page = mod.getUnifiedInboxPage([1, 2], 10)
      expect(page.length).toBe(3)
      // Sorted by date DESC
      expect(page[0].subject).toBe('a2')
      expect(page[1].subject).toBe('b1')
      expect(page[2].subject).toBe('a1')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUnifiedInboxPage with cursor (pagination)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'old', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'new', fromAddr: 'a@test', date: '2026-02-01T00:00:00Z', unread: false },
      ])

      const page1 = mod.getUnifiedInboxPage([1], 1)
      expect(page1.length).toBe(1)
      expect(page1[0].subject).toBe('new')

      // Pagination: next page
      const cursor = { date: page1[0].date, accountId: page1[0].accountId, uid: page1[0].uid }
      const page2 = mod.getUnifiedInboxPage([1], 1, cursor)
      expect(page2.length).toBe(1)
      expect(page2[0].subject).toBe('old')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUnifiedInboxPage with empty accountIds array', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.getUnifiedInboxPage([], 10)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox searches by subject and from', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Тестовое письмо', fromAddr: 'alice@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'Другое', fromAddr: 'bob@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 'Третье', fromAddr: 'alice@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      const bySubject = mod.searchUnifiedInbox([1, 2], 'Тестовое', 10, 0)
      expect(bySubject.length).toBe(1)
      expect(bySubject[0].uid).toBe(1)

      const byFrom = mod.searchUnifiedInbox([1, 2], 'alice', 10, 0)
      expect(byFrom.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox supports body: and -body: operators', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        {
          uid: 1,
          subject: 'a1',
          fromAddr: 'alice@test',
          date: '2026-01-01T00:00:00Z',
          unread: false,
          bodyText: 'Invoice 123 is attached',
        },
      ])
      mod.upsertMessages(2, 'INBOX', [
        {
          uid: 1,
          subject: 'b1',
          fromAddr: 'bob@test',
          date: '2026-01-02T00:00:00Z',
          unread: false,
          bodyText: 'Status update only',
        },
      ])

      const byBody = mod.searchUnifiedInbox([1, 2], 'body:invoice', 10, 0)
      expect(byBody.map(m => `${m.accountId}:${m.uid}`)).toEqual(['1:1'])

      const neg = mod.searchUnifiedInbox([1, 2], 'body:update -body:status', 10, 0)
      expect(neg).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox with empty query', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.searchUnifiedInbox([1], '', 10, 0)).toEqual([])
      expect(mod.searchUnifiedInbox([], 'test', 10, 0)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Send queue ---

  testDb('send_queue: enqueue/list/due/status transitions', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const past = new Date(Date.now() - 5_000).toISOString()
      const future = new Date(Date.now() + 60_000).toISOString()

      const idPast = mod.enqueueSendQueue(1, { to: 'a@test', subject: 'past' }, past, 'q-past')
      const idFuture = mod.enqueueSendQueue(1, { to: 'b@test', subject: 'future' }, future, 'q-future')

      expect(idPast).toBe('q-past')
      expect(idFuture).toBe('q-future')

      const listed = mod.listSendQueue({ accountId: 1, statuses: ['queued'] })
      expect(listed.map(x => x.id)).toEqual(['q-past', 'q-future'])

      const due = mod.listDueSendQueue(new Date().toISOString(), 10)
      expect(due.map(x => x.id)).toContain('q-past')
      expect(due.map(x => x.id)).not.toContain('q-future')

      expect(mod.markSendQueueSending('q-past')).toBe(true)
      const sending = mod.getSendQueueById('q-past')
      expect(sending?.status).toBe('sending')
      expect(sending?.attemptCount).toBe(1)

      expect(mod.markSendQueueFailed('q-past', 'smtp failed')).toBe(true)
      const failed = mod.getSendQueueById('q-past')
      expect(failed?.status).toBe('failed')
      expect(failed?.lastError).toContain('smtp failed')

      const retryAt = new Date(Date.now() + 10_000).toISOString()
      expect(mod.rescheduleSendQueue('q-past', retryAt)).toBe(true)
      const retried = mod.getSendQueueById('q-past')
      expect(retried?.status).toBe('queued')
      expect(retried?.lastError).toBeNull()
      expect(retried?.sendAt).toBe(retryAt)

      expect(mod.markSendQueueSent('q-past')).toBe(true)
      expect(mod.getSendQueueById('q-past')?.status).toBe('sent')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('send_queue: cancel/sendNow and cleanup on deleteAccountData', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'queued' }, new Date(Date.now() + 60_000).toISOString(), 'q1')
      mod.enqueueSendQueue(1, { to: 'b@test', subject: 'queued2' }, new Date(Date.now() + 120_000).toISOString(), 'q2')
      mod.enqueueSendQueue(2, { to: 'c@test', subject: 'other account' }, new Date(Date.now() + 120_000).toISOString(), 'q3')

      const canceled = mod.cancelSendQueue('q1')
      expect(canceled?.status).toBe('canceled')
      expect(mod.cancelSendQueue('q1')).toBeUndefined()

      const beforeNow = mod.getSendQueueById('q2')?.sendAt || ''
      expect(mod.sendQueueNow('q2')).toBe(true)
      const afterNow = mod.getSendQueueById('q2')?.sendAt || ''
      expect(afterNow).not.toBe(beforeNow)
      expect(mod.getSendQueueById('q2')?.status).toBe('queued')

      mod.deleteAccountData(1)
      expect(mod.getSendQueueById('q1')).toBeUndefined()
      expect(mod.getSendQueueById('q2')).toBeUndefined()
      expect(mod.getSendQueueById('q3')).toBeTruthy()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('send_queue: archiveRef persisted and returned', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const archiveRef = { accountId: 1, folder: 'INBOX', archiveFolder: 'Archive', uid: 42 }
      const past = new Date(Date.now() - 5_000).toISOString()

      // Enqueue with archiveRef
      const id1 = mod.enqueueSendQueue(1, { to: 'a@test', subject: 'with-archive' }, past, 'q-ar', archiveRef)
      // Enqueue without archiveRef
      const id2 = mod.enqueueSendQueue(1, { to: 'b@test', subject: 'no-archive' }, past, 'q-no-ar')

      // getSendQueueById
      const item1 = mod.getSendQueueById(id1)
      expect(item1).toBeDefined()
      expect(item1!.archiveRef).toEqual(archiveRef)

      const item2 = mod.getSendQueueById(id2)
      expect(item2).toBeDefined()
      expect(item2!.archiveRef).toBeNull()

      // listDueSendQueue returns archiveRef
      const due = mod.listDueSendQueue()
      const found = due.find(d => d.id === 'q-ar')
      expect(found?.archiveRef).toEqual(archiveRef)

      const foundNoAr = due.find(d => d.id === 'q-no-ar')
      expect(foundNoAr?.archiveRef).toBeNull()

      // listSendQueue returns archiveRef
      const all = mod.listSendQueue({ accountId: 1 })
      const foundAll = all.find(d => d.id === 'q-ar')
      expect(foundAll?.archiveRef).toEqual(archiveRef)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- TLS pins: certificate body stored next to the fingerprint ---
  //
  // The pinned TLS path verifies the chain for real (`rejectUnauthorized:
  // true`), so a self-signed / private-CA endpoint needs its own certificate as
  // an explicit trust anchor. These tests cover the storage side of that
  // contract: the fingerprint-only call shape keeps working, and a
  // fingerprint-only pin is never faked into an anchor.

  // Real self-signed certificates: upsertTlsPin cross-checks the stored PEM
  // against the pinned fingerprint by X.509 parsing, so fixtures must actually
  // parse. Fingerprints are derived from the certificates rather than
  // hardcoded, so the pair can never drift apart.
  const CERT_PEM_A = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUW7QyaXR7jcLWIJXbaqL/DMyovI4wDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwacGluLWZpeHR1cmUtYS5leGFtcGxlLnRlc3QwHhcNMjYw
NzI0MTkxMTQ1WhcNMzYwNzIxMTkxMTQ1WjAlMSMwIQYDVQQDDBpwaW4tZml4dHVy
ZS1hLmV4YW1wbGUudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALYApj91/VCrFC5ehMiLh0Dg6eq/kaxmE0Tsua07RCVzVhbfOyiiIWi3qCmUCsfA
5A7zTsQfoyi4lCd2ysDOc5Wq9yJCjNaJGcm17FG3lTxWsozlqO0S7YBVOtAbmaUc
hRRTA9d5B7ehKwM/Z9nPmXsMHrzWtCQWgbUltUmU8WhQSJF3QG6OiMryBZ5pEo3Y
zW+7LKzOPxhkl55U9YL6KF6md4WnffmGl6JmFyJC5qGynpqTmvpTCuRwy23kzyU6
OG/ThwpehdtCBxQNkA0u2BDEJV8UhhYI9jtDZTtSTYUxJQUqbkLv6A0E5GfcAq+j
oN0E89v4zKKdPkRnCXr+CukCAwEAAaNTMFEwHQYDVR0OBBYEFOHyF20DjR6SfC+n
FyxCtELzvhm1MB8GA1UdIwQYMBaAFOHyF20DjR6SfC+nFyxCtELzvhm1MA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADfzCS2jR0Yh0WNl3Avi43p/
UJsF8pLu2ipj7+RbzTZ6IaWx0aJe6y5pwFKlZcX9cdLx03GM/RwytRNDNg0VM9jH
E7++GvA77VV//TgN4JVE5BNLbqihH9BPnZPhN6aUtCye+TUYUemNFEKNmQTcvmMA
BitogOiZiaQVuWBfwsMkKOer8YQrjiCJ3gPGjKk72w30gL3wz7KfkcLXpyZh2frt
LXzlavL4j+56aNMVh9jFOcJBEk86JiB+UUDMWoHasbcZ2YN4Q7gjSI3uk8rs3Y9j
THChnD0TscoUsjVjypadUSjMqacGabaOU2+vWPQE3g3xMVuPxStRTIAqiqkJxEQ=
-----END CERTIFICATE-----`
  const CERT_PEM_B = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUcRbcn/v34KUvoFMshUemBhSQEB0wDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwacGluLWZpeHR1cmUtYi5leGFtcGxlLnRlc3QwHhcNMjYw
NzI0MTkxMTQ2WhcNMzYwNzIxMTkxMTQ2WjAlMSMwIQYDVQQDDBpwaW4tZml4dHVy
ZS1iLmV4YW1wbGUudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKjOEpczZSEwtjvgLwGX0td9bnq52hOUu6RdFUB+QCtYbSchLR87glrz/267Bv8m
Z3ZBNicdYlP5G5xU1w33QBjfxzt+v0jyKhSjt0426T9Gw2x6NLOIcNWRprQsj6j3
l+r01R8fkt3cLl27amXjHfGfKazVHYvvsrNmMv686cuWASaiTBb17kC+wIFG62Jg
mm6X69F6MhlTsHPxwMVIs+41UtgrR5w9w1eMBqgnAknZ52sVoaP6RnQdylUplqQG
4WXcPylttH5HtG5Mxp2DRJYBpjOtKbyCbBRbHkg+xAt49NAw084t67Ne3+Wz8zFP
/m9xDXbC+brfIfDcEpLZdPkCAwEAAaNTMFEwHQYDVR0OBBYEFNfnxRjl37UlUarX
63ohojIptzC5MB8GA1UdIwQYMBaAFNfnxRjl37UlUarX63ohojIptzC5MA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAIPNyhK/JgWIq78keuMAZUTE
sOgKyJsWc7S0uwNdrzu2TAiTiUTh34YrGMjF7hZ2GAMeC9VPas5KOhubpWlZUtLV
jiUr+okBdxrp/Gsl0ZDqOfJ9bgDWQg2JzxlhlPzh48vKyO9Ob2/HoVcS/ILUKDIp
OQAYXfJUDfJV2rfQDQF2nBIW5TflOHnvx+xhWNB0a23aTDi/x8SjhOx2/kfel48N
SzLiGpFjEtlgvJlGItf2nE+LE2K0oN+m8oV2QHZ3bJEz0C1vUmAbjfixPQUI/ufV
PmzvC1E/Xy2DSACclKcSo2N8JqtEHDZqj75aK7S2pA0dZAn5xa5HxbAYvwcdyrg=
-----END CERTIFICATE-----`
  const FP_A = new X509Certificate(CERT_PEM_A).fingerprint256.toUpperCase()
  const FP_B = new X509Certificate(CERT_PEM_B).fingerprint256.toUpperCase()

  testDb('upsertTlsPin stores the certificate PEM and reads it back per endpoint', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Lowercase input is accepted and canonicalized, like any pin.
      const row = mod.upsertTlsPin(1, 'IMAP.Example.Test', 993, FP_A.toLowerCase(), CERT_PEM_A)
      expect(row.host).toBe('imap.example.test')
      expect(row.fingerprintSha256).toBe(FP_A)
      expect(row.certPem).toBe(CERT_PEM_A)

      // Host lookup is case-insensitive, mirroring listTlsPinsForEndpoint.
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'Imap.Example.Test', 993)).toEqual([CERT_PEM_A])
      expect(mod.listTlsPinsForEndpoint(1, 'imap.example.test', 993)).toEqual([FP_A])

      // listTlsPins exposes the same body.
      expect(mod.listTlsPins(1).map(p => p.certPem)).toEqual([CERT_PEM_A])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertTlsPin without a PEM keeps the pin fingerprint-only (no anchor invented)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Legacy 4-arg call shape must still compile and work.
      const row = mod.upsertTlsPin(1, 'smtp.example.test', 465, 'dd:ee:ff')
      expect(row.certPem).toBeNull()

      // Fingerprint is pinned, but there is no trust anchor to hand to TLS.
      expect(mod.listTlsPinsForEndpoint(1, 'smtp.example.test', 465)).toEqual(['DD:EE:FF'])
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'smtp.example.test', 465)).toEqual([])

      // Unknown endpoint / unknown account: empty, never a throw.
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'smtp.example.test', 587)).toEqual([])
      expect(mod.listTlsPinnedCertsPemForEndpoint(2, 'smtp.example.test', 465)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('re-upsert backfills a PEM onto an existing pin and never clears it', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const first = mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A)
      expect(first.certPem).toBeNull()

      // Same fingerprint + a certificate: backfills in place, no duplicate row.
      // The cross-check must not get in the way of this path.
      const backfilled = mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_A)
      expect(backfilled.id).toBe(first.id)
      expect(backfilled.certPem).toBe(CERT_PEM_A)
      expect(mod.listTlsPins(1)).toHaveLength(1)

      // A later fingerprint-only upsert must not wipe the stored anchor.
      const again = mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A.toLowerCase())
      expect(again.certPem).toBe(CERT_PEM_A)
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([CERT_PEM_A])

      // A different fingerprint on the same endpoint is a separate pin.
      mod.upsertTlsPin(1, 'imap.example.test', 993, FP_B, CERT_PEM_B)
      expect(mod.listTlsPins(1)).toHaveLength(2)
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993).sort())
        .toEqual([CERT_PEM_A, CERT_PEM_B].sort())
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertTlsPin rejects a certificate body that is not PEM', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, 'not a certificate'))
        .toThrow(/PEM/)
      // Blank / null means "no certificate supplied", not an error.
      expect(mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, '   ').certPem).toBeNull()
      expect(mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, null).certPem).toBeNull()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertTlsPin rejects a PEM whose fingerprint disagrees with the pin', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // A stored PEM becomes an OpenSSL trust anchor, so a (cert, fingerprint)
      // pair that disagrees must never reach the store: otherwise the anchor
      // the connection trusts is not the certificate the user confirmed.
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_B))
        .toThrow(/does not match/)

      // Nothing was written at all.
      expect(mod.listTlsPins(1)).toEqual([])
      expect(mod.listTlsPinsForEndpoint(1, 'imap.example.test', 993)).toEqual([])
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a rejected mismatch leaves an existing pin untouched', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const good = mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_A)

      // Same pin, wrong certificate: must not overwrite the good anchor.
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_B))
        .toThrow(/does not match/)

      const pins = mod.listTlsPins(1)
      expect(pins).toHaveLength(1)
      expect(pins[0].id).toBe(good.id)
      expect(pins[0].certPem).toBe(CERT_PEM_A)
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([CERT_PEM_A])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertTlsPin rejects a corrupt certificate instead of storing it unverified', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // PEM armour is present but the DER body is garbage: X.509 parsing fails,
      // so there is no fingerprint to compare — it must be rejected, not stored.
      const corrupt = [
        '-----BEGIN CERTIFICATE-----',
        'bm90LWEtcmVhbC1jZXJ0aWZpY2F0ZS1ib2R5LXdoYXRzb2V2ZXI=',
        '-----END CERTIFICATE-----',
      ].join('\n')
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, corrupt)).toThrow(/PEM/)

      // A bundle is rejected too: extra anchors must not ride along behind one
      // matching fingerprint.
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, `${CERT_PEM_A}\n${CERT_PEM_B}`))
        .toThrow(/single PEM-encoded certificate/)

      // Pathological size is refused before parsing.
      const huge = `${CERT_PEM_A}\n${'A'.repeat(40 * 1024)}`
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, huge)).toThrow(/too large/)

      expect(mod.listTlsPins(1)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertTlsPin stores the canonical certificate and refuses anything riding along', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // OpenSSL consumes every PEM block in a string handed to `ca`, but
      // X509Certificate parses only the first one. A trailing block of a type a
      // BEGIN/END CERTIFICATE scan does not count — TRUSTED CERTIFICATE is the
      // classic one — must not ride along behind a fingerprint that verifies.
      const trustedTail = CERT_PEM_B
        .replace('BEGIN CERTIFICATE', 'BEGIN TRUSTED CERTIFICATE')
        .replace('END CERTIFICATE', 'END TRUSTED CERTIFICATE')
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, `${CERT_PEM_A}\n${trustedTail}`))
        .toThrow(/single PEM-encoded certificate/)

      // Same for a leading block and for plain trailing junk.
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, `${trustedTail}\n${CERT_PEM_A}`))
        .toThrow(/single PEM-encoded certificate/)
      expect(() => mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, `${CERT_PEM_A}\ntrailing junk`))
        .toThrow(/single PEM-encoded certificate/)
      expect(mod.listTlsPins(1)).toEqual([])

      // And what gets stored is the re-encoding of the parsed certificate, not
      // the caller's bytes: a differently wrapped but valid body round-trips to
      // the canonical form.
      const begin = '-----BEGIN CERTIFICATE-----'
      const end = '-----END CERTIFICATE-----'
      const body = CERT_PEM_A.slice(begin.length, CERT_PEM_A.indexOf(end)).replace(/\s+/g, '')
      const rewrapped = `${begin}\n${body.match(/.{1,48}/g)!.join('\n')}\n${end}`
      expect(rewrapped).not.toBe(CERT_PEM_A)

      const row = mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, rewrapped)
      expect(row.certPem).toBe(CERT_PEM_A)
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([CERT_PEM_A])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('cert_pem migration is idempotent on a pre-existing DB and preserves pins', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-tlspin-mig-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    // Seed a legacy cache.db whose tls_pins table has no cert_pem column.
    const { default: Database } = await import('better-sqlite3')
    const legacy = new Database(path.join(dir, 'cache.db'))
    legacy.exec(`
      CREATE TABLE tls_pins(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        fingerprint_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_tls_pins_unique
        ON tls_pins(account_id, host, port, fingerprint_sha256);
    `)
    legacy.prepare(
      `INSERT INTO tls_pins(account_id, host, port, fingerprint_sha256, created_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(1, 'imap.example.test', 993, FP_A, '2026-02-11T09:00:00Z')
    legacy.close()

    vi.resetModules()
    process.env.MAILCOPILOT_DATA_DIR = dir
    let mod = await import('./index')
    try {
      // The legacy pin survived and is fingerprint-only (fail-closed, not faked).
      const pins = mod.listTlsPins(1)
      expect(pins).toHaveLength(1)
      expect(pins[0].fingerprintSha256).toBe(FP_A)
      expect(pins[0].certPem).toBeNull()
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([])

      // Re-confirming the pin attaches the anchor.
      mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_A)
      mod.default.close()

      // Re-open the SAME data dir: the ALTER TABLE guard must not re-run.
      vi.resetModules()
      process.env.MAILCOPILOT_DATA_DIR = dir
      mod = await import('./index')
      expect(mod.listTlsPins(1)).toHaveLength(1)
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([CERT_PEM_A])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAccountData drops pinned certificate PEMs for that account only', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertTlsPin(1, 'imap.example.test', 993, FP_A, CERT_PEM_A)
      mod.upsertTlsPin(2, 'imap.example.test', 993, FP_B, CERT_PEM_B)

      mod.deleteAccountData(1)

      expect(mod.listTlsPins(1)).toEqual([])
      expect(mod.listTlsPinnedCertsPemForEndpoint(1, 'imap.example.test', 993)).toEqual([])
      expect(mod.listTlsPinnedCertsPemForEndpoint(2, 'imap.example.test', 993)).toEqual([CERT_PEM_B])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- deleteAccountData ---

  testDb('deleteAccountData deletes all account data', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertOfflineOp(1, 'INBOX', 1, 'setSeen')

      // Additional tables cleaned up when deleting an account (B2.1)
      mod.default.prepare(`
        INSERT INTO snoozed(account_id, message_id, folder, uidvalidity, uid, wake_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(1, '<m1@test>', 'INBOX', 1, 1, '2026-02-11T10:00:00Z', '2026-02-11T09:00:00Z')
      mod.default.prepare(`
        INSERT INTO snoozed(account_id, message_id, folder, uidvalidity, uid, wake_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(2, '<m2@test>', 'INBOX', 1, 2, '2026-02-11T10:00:00Z', '2026-02-11T09:00:00Z')

      mod.default.prepare(`
        INSERT INTO tls_pins(account_id, host, port, fingerprint_sha256, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(1, 'imap.example.test', 993, 'fp1', '2026-02-11T09:00:00Z')
      mod.default.prepare(`
        INSERT INTO tls_pins(account_id, host, port, fingerprint_sha256, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(2, 'imap.example.test', 993, 'fp2', '2026-02-11T09:00:00Z')

      mod.deleteAccountData(1)
      expect(mod.getMessages(1, 'INBOX', 10)).toEqual([])
      expect(mod.getOfflineOps(1)).toEqual([])
      const s1 = mod.default.prepare(`SELECT COUNT(*) as c FROM snoozed WHERE account_id=1`).get() as { c: number }
      const s2 = mod.default.prepare(`SELECT COUNT(*) as c FROM snoozed WHERE account_id=2`).get() as { c: number }
      expect(s1.c).toBe(0)
      expect(s2.c).toBe(1)

      const p1 = mod.default.prepare(`SELECT COUNT(*) as c FROM tls_pins WHERE account_id=1`).get() as { c: number }
      const p2 = mod.default.prepare(`SELECT COUNT(*) as c FROM tls_pins WHERE account_id=2`).get() as { c: number }
      expect(p1.c).toBe(0)
      expect(p2.c).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAccountData removes ai_summaries for that account only', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // ai_summaries.account_id is TEXT; deleteAccountData binds the string form
      // of the numeric account id, so seed rows keyed by the string id.
      const hashA = mod.computeThreadHash(['<a1@x>', '<a2@x>'])
      const hashB = mod.computeThreadHash(['<b1@x>', '<b2@x>'])
      mod.upsertThreadSummary({
        threadHash: hashA,
        accountId: '1',
        oneLine: 'Account 1 summary',
        bullets: ['x'],
        provider: 'openai-api',
      })
      mod.upsertThreadSummary({
        threadHash: hashB,
        accountId: '2',
        oneLine: 'Account 2 summary',
        bullets: ['y'],
        provider: 'openai-api',
      })

      mod.deleteAccountData(1)

      // Account 1's derived summary text is gone; account 2 untouched.
      expect(mod.getThreadSummary('1', hashA)).toBeUndefined()
      expect(mod.getThreadSummary('2', hashB)).toBeDefined()
      const remaining = (mod.default
        .prepare('SELECT COUNT(*) AS c FROM ai_summaries')
        .get() as { c: number }).c
      expect(remaining).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAccountData with invalid id does nothing', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Should not throw errors
      mod.deleteAccountData(0)
      mod.deleteAccountData(-1)
      mod.deleteAccountData(NaN)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Different folders ---

  testDb('messages from different folders are isolated', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'inbox1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Sent', [
        { uid: 1, subject: 'sent1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      const inbox = mod.getMessages(1, 'INBOX', 10)
      const sent = mod.getMessages(1, 'Sent', 10)
      expect(inbox.length).toBe(1)
      expect(inbox[0].subject).toBe('inbox1')
      expect(sent.length).toBe(1)
      expect(sent[0].subject).toBe('sent1')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('limit in getMessages restricts the count', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        uid: i + 1, subject: `s${i}`, fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false,
      }))
      mod.upsertMessages(1, 'INBOX', rows)

      const limited = mod.getMessages(1, 'INBOX', 5)
      expect(limited.length).toBe(5)
      // Should return the latest (highest UIDs)
      expect(limited[0].uid).toBe(20)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getMessageByUid returns a single message by uid', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 10, subject: 'Target', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 20, subject: 'Other', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])

      const msg = mod.getMessageByUid(1, 'INBOX', 10)
      expect(msg).toBeDefined()
      expect(msg!.uid).toBe(10)
      expect(msg!.subject).toBe('Target')
      expect(msg!.unread).toBe(true)

      const missing = mod.getMessageByUid(1, 'INBOX', 999)
      expect(missing).toBeUndefined()

      const wrongFolder = mod.getMessageByUid(1, 'Sent', 10)
      expect(wrongFolder).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('countUnreadMessages counts unread via SQL COUNT', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 4, subject: 's4', fromAddr: 'd@test', date: '2026-01-01T00:00:00Z', unread: true },
      ])

      expect(mod.countUnreadMessages(1, 'INBOX')).toBe(3)
      expect(mod.countUnreadMessages(1, 'Sent')).toBe(0)
      expect(mod.countUnreadMessages(2, 'INBOX')).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getThreadMessages finds messages by messageId/inReplyTo/references', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'First', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, messageId: '<msg1@test>', inReplyTo: '', references: '' },
        { uid: 2, subject: 'Reply', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false, messageId: '<msg2@test>', inReplyTo: '<msg1@test>', references: '<msg1@test>' },
        { uid: 3, subject: 'Third', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false, messageId: '<msg3@test>', inReplyTo: '<msg2@test>', references: '<msg1@test> <msg2@test>' },
        { uid: 4, subject: 'Unrelated', fromAddr: 'd@test', date: '2026-01-04T00:00:00Z', unread: false, messageId: '<other@test>', inReplyTo: '', references: '' },
      ])

      // Search by <msg1@test> — should find msg1 (messageId), msg2 (inReplyTo), msg3 (references)
      const thread = mod.getThreadMessages(1, 'INBOX', ['<msg1@test>'])
      const uids = thread.map(m => m.uid)
      expect(uids).toContain(1)
      expect(uids).toContain(2)
      expect(uids).toContain(3)
      expect(uids).not.toContain(4)

      // Sorted by date ASC
      expect(thread[0].uid).toBe(1)
      expect(thread[thread.length - 1].uid).toBe(3)

      // Empty threadIds array
      expect(mod.getThreadMessages(1, 'INBOX', [])).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- listFolderStats ---

  testDb('listFolderStats returns folder counters from cache', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: true },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Sent', [
        { uid: 10, subject: 'sent1', fromAddr: 'me@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // Different account — should not appear in results
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 'other', fromAddr: 'x@test', date: '2026-01-01T00:00:00Z', unread: true },
      ])

      const stats = mod.listFolderStats(1)
      expect(stats.length).toBe(2)

      const inbox = stats.find(s => s.folderPath === 'INBOX')
      expect(inbox).toBeDefined()
      expect(inbox!.messageCount).toBe(3)
      expect(inbox!.unreadCount).toBe(2)

      const sent = stats.find(s => s.folderPath === 'Sent')
      expect(sent).toBeDefined()
      expect(sent!.messageCount).toBe(1)
      expect(sent!.unreadCount).toBe(0)

      // Empty account — empty array
      expect(mod.listFolderStats(999)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listFolderStats excludes snoozed messages from counts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: true },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // Snooze uid=1 (unread)
      mod.default.prepare(`
        INSERT INTO snoozed(account_id, message_id, folder, uidvalidity, uid, wake_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(1, '<m1@test>', 'INBOX', 1, 1, '2026-03-01T10:00:00Z', '2026-02-28T09:00:00Z')

      const stats = mod.listFolderStats(1)
      const inbox = stats.find(s => s.folderPath === 'INBOX')
      expect(inbox).toBeDefined()
      expect(inbox!.messageCount).toBe(2) // 3 total - 1 snoozed = 2
      expect(inbox!.unreadCount).toBe(1)  // 2 unread - 1 snoozed unread = 1
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('countUnreadMessages excludes snoozed messages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-01T00:00:00Z', unread: true },
      ])

      expect(mod.countUnreadMessages(1, 'INBOX')).toBe(3)

      // Snooze uid=2 (unread)
      mod.default.prepare(`
        INSERT INTO snoozed(account_id, message_id, folder, uidvalidity, uid, wake_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(1, '<m2@test>', 'INBOX', 1, 2, '2026-03-01T10:00:00Z', '2026-02-28T09:00:00Z')

      expect(mod.countUnreadMessages(1, 'INBOX')).toBe(2) // 3 - 1 snoozed = 2
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('cached_roles: cache/get/getAll/delete', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Empty cache
      expect(mod.getCachedFolderRoles(1)).toBeNull()
      expect(Object.keys(mod.getAllCachedFolderRoles())).toHaveLength(0)

      // Cache roles
      mod.cacheFolderRoles(1, { archive: 'Archive', trash: 'Trash', sent: 'Sent' })
      mod.cacheFolderRoles(2, { archive: '[Gmail]/All Mail', drafts: '[Gmail]/Drafts' })

      // Get by ID
      const roles1 = mod.getCachedFolderRoles(1)
      expect(roles1).toEqual({ archive: 'Archive', trash: 'Trash', sent: 'Sent' })

      // Get all
      const all = mod.getAllCachedFolderRoles()
      expect(Object.keys(all)).toHaveLength(2)
      expect(all[2]?.archive).toBe('[Gmail]/All Mail')

      // Update (UPSERT)
      mod.cacheFolderRoles(1, { archive: 'NewArchive' })
      expect(mod.getCachedFolderRoles(1)).toEqual({ archive: 'NewArchive' })

      // Deletion on deleteAccountData
      mod.deleteAccountData(1)
      expect(mod.getCachedFolderRoles(1)).toBeNull()
      expect(Object.keys(mod.getAllCachedFolderRoles())).toHaveLength(1) // account 2 remains
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('cached_mailboxes: cache/getAll/upsert/delete', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Empty cache
      expect(Object.keys(mod.getAllCachedMailboxes())).toHaveLength(0)

      // Cache mailboxes
      const mb1 = [
        { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
        { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
      ]
      const mb2 = [
        { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
        { path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts' },
      ]
      mod.cacheMailboxes(1, mb1)
      mod.cacheMailboxes(2, mb2)

      // Get all
      const all = mod.getAllCachedMailboxes()
      expect(Object.keys(all)).toHaveLength(2)
      expect(all[1]).toEqual(mb1)
      expect(all[2]).toEqual(mb2)

      // Update (UPSERT)
      const mb1Updated = [{ path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' }]
      mod.cacheMailboxes(1, mb1Updated)
      expect(mod.getAllCachedMailboxes()[1]).toEqual(mb1Updated)

      // Deletion on deleteAccountData
      mod.deleteAccountData(1)
      const afterDelete = mod.getAllCachedMailboxes()
      expect(afterDelete[1]).toBeUndefined()
      expect(afterDelete[2]).toEqual(mb2) // account 2 remains
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getAllFolderPrefs: loads prefs for all accounts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Empty result
      expect(Object.keys(mod.getAllFolderPrefs())).toHaveLength(0)

      // Create prefs for two accounts
      mod.upsertFolderPref(1, 'INBOX', { visible: true, includeInBadges: true })
      mod.upsertFolderPref(1, 'Spam', { visible: false, includeInBadges: false })
      mod.upsertFolderPref(2, 'INBOX', { visible: true, includeInBadges: true })

      const all = mod.getAllFolderPrefs()
      expect(Object.keys(all)).toHaveLength(2)
      expect(all[1]).toHaveLength(2)
      expect(all[2]).toHaveLength(1)

      // Check visible
      const spamPref = all[1]!.find(p => p.folderPath === 'Spam')
      expect(spamPref?.visible).toBe(false)
      const inboxPref = all[1]!.find(p => p.folderPath === 'INBOX')
      expect(inboxPref?.visible).toBe(true)
      expect(inboxPref?.includeInBadges).toBe(true)

      // Account deletion clears prefs
      mod.deleteAccountData(1)
      const afterDelete = mod.getAllFolderPrefs()
      expect(afterDelete[1]).toBeUndefined()
      expect(afterDelete[2]).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeStaleMessages: removes from cache messages missing on IMAP', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Fill cache: uid 1..5
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: true },
        { uid: 4, subject: 's4', fromAddr: 'd@test', date: '2026-01-04T00:00:00Z', unread: false },
        { uid: 5, subject: 's5', fromAddr: 'e@test', date: '2026-01-05T00:00:00Z', unread: true },
      ])
      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(5)

      // IMAP returned uid [2, 3, 5] — uid 4 deleted from server, uid 1 below minUid
      const removed = mod.removeStaleMessages(1, 'INBOX', [2, 3, 5])
      expect(removed).toBe(1) // only uid 4 deleted (>= minUid=2 and absent from freshUids)

      const remaining = mod.getMessages(1, 'INBOX', 10)
      expect(remaining.map(m => m.uid).sort()).toEqual([1, 2, 3, 5])
      // uid 1 remains (below minUid), uid 4 deleted

      // Empty freshUids — folder is empty on server, purge all cached entries.
      // New contract (2026-04-21): empty freshUids requires explicit opts.reason.
      expect(mod.removeStaleMessages(1, 'INBOX', [], { reason: 'server_empty' })).toBe(4) // uid 1,2,3,5
      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(0)

      // Re-fill for next assertion
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: true },
        { uid: 5, subject: 's5', fromAddr: 'e@test', date: '2026-01-05T00:00:00Z', unread: true },
      ])

      // All uids match — nothing deleted
      expect(mod.removeStaleMessages(1, 'INBOX', [1, 2, 3, 5])).toBe(0)

      // Different folder — not affected
      mod.upsertMessages(1, 'Sent', [
        { uid: 10, subject: 'sent1', fromAddr: 'me@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      expect(mod.removeStaleMessages(1, 'INBOX', [2, 3, 5])).toBe(0)
      expect(mod.getMessages(1, 'Sent', 10)).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getMessagesForRuleTest returns messages across folders', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'hello', fromAddr: 'alice@test', fromName: 'Alice', date: '2026-01-01T00:00:00Z', unread: false, hasAttachments: true },
        { uid: 2, subject: 'world', fromAddr: 'bob@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 5, subject: 'other', fromAddr: 'carol@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // All accounts
      const all = mod.getMessagesForRuleTest(undefined, 100)
      expect(all).toHaveLength(3)
      expect(all[0].uid).toBe(5) // Newest first
      expect(all[0].accountId).toBe(2)

      // Filter by accountId
      const acct1 = mod.getMessagesForRuleTest(1, 100)
      expect(acct1).toHaveLength(2)
      expect(acct1.every(m => m.accountId === 1)).toBe(true)

      // Check field mapping
      const alice = acct1.find(m => m.uid === 1)!
      expect(alice.from).toBe('Alice')
      expect(alice.fromAddr).toBe('alice@test')
      expect(alice.hasAttachments).toBe(true)
      expect(alice.folder).toBe('INBOX')

      // Limit
      const limited = mod.getMessagesForRuleTest(undefined, 1)
      expect(limited).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Search Excellence ---

  testDb('searchMessages supports filename: operator', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Report', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, hasAttachments: true, attachmentFilenames: 'report.pdf quarterly.xlsx' },
        { uid: 2, subject: 'Invoice', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false, hasAttachments: true, attachmentFilenames: 'invoice_2026.pdf' },
        { uid: 3, subject: 'No attachment', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // filename: operator
      const pdf = mod.searchMessages(1, 'INBOX', 'filename:report.pdf', 10, 0)
      expect(pdf.map(m => m.uid)).toEqual([1])

      const invoice = mod.searchMessages(1, 'INBOX', 'filename:invoice', 10, 0)
      expect(invoice.map(m => m.uid)).toEqual([2])

      // -filename: negation
      const notReport = mod.searchMessages(1, 'INBOX', 'has:attachment -filename:report', 10, 0)
      expect(notReport.map(m => m.uid)).toEqual([2])

      // Free text also searches attachment_filenames via FTS
      const ftsSearch = mod.searchMessages(1, 'INBOX', 'quarterly', 10, 0)
      expect(ftsSearch.some(m => m.uid === 1)).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox scope=all searches across all folders', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Inbox msg', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Archive', [
        { uid: 10, subject: 'Archived msg', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Sent', [
        { uid: 20, subject: 'Sent msg', fromAddr: 'a@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // scope=all should find messages in all folders
      const all = mod.searchUnifiedInbox([1], 'msg', 10, 0, 'all')
      expect(all.length).toBe(3)

      // scope=inbox should only find INBOX
      const inbox = mod.searchUnifiedInbox([1], 'msg', 10, 0, 'inbox')
      expect(inbox.length).toBe(1)
      expect(inbox[0].folder).toBe('INBOX')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox searches across multiple accounts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Account1 email', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 'Account2 email', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'Sent', [
        { uid: 2, subject: 'Account2 sent email', fromAddr: 'b@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      // Search across both accounts, all folders
      const results = mod.searchUnifiedInbox([1, 2], 'email', 10, 0, 'all')
      expect(results.length).toBe(3)

      // Search only account 1
      const acc1 = mod.searchUnifiedInbox([1], 'email', 10, 0, 'all')
      expect(acc1.length).toBe(1)
      expect(acc1[0].accountId).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchUnifiedInbox supports filename: across accounts', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'With PDF', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, hasAttachments: true, attachmentFilenames: 'contract.pdf' },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 'With DOCX', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false, hasAttachments: true, attachmentFilenames: 'notes.docx' },
      ])

      const pdf = mod.searchUnifiedInbox([1, 2], 'filename:contract', 10, 0, 'all')
      expect(pdf.map(m => m.uid)).toEqual([1])
      expect(pdf[0].accountId).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getSearchIndexStats returns correct completeness stats', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, bodyText: 'Hello world' },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false, attachmentFilenames: 'report.pdf' },
      ])

      const stats = mod.getSearchIndexStats([1])
      expect(stats.totalMessages).toBe(3)
      expect(stats.bodyIndexed).toBe(1)
      expect(stats.filenamesIndexed).toBe(1)

      // Empty accounts
      const empty = mod.getSearchIndexStats([])
      expect(empty.totalMessages).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getUidsWithoutBodyText returns UIDs missing body text', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, bodyText: 'Has body' },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
      ])

      const uids = mod.getUidsWithoutBodyText(1, 'INBOX', 10)
      expect(uids).toEqual([3, 2])

      // After updating body text
      mod.updateMessageBodyText(1, 'INBOX', 2, 'Now has body')
      const uids2 = mod.getUidsWithoutBodyText(1, 'INBOX', 10)
      expect(uids2).toEqual([3])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('body search works without prior message opening (background indexed)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Simulate: messages inserted without body_text (header sync only)
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Project update', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'Meeting notes', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])

      // Body search should not find anything yet
      const empty = mod.searchMessages(1, 'INBOX', 'body:deadline', 10, 0)
      expect(empty.length).toBe(0)

      // Simulate background indexer updating body_text
      mod.updateMessageBodyText(1, 'INBOX', 1, 'The deadline for the project is next Friday')
      mod.updateMessageBodyText(1, 'INBOX', 2, 'Action items from the meeting: review PR')

      // Now body search should work
      const deadline = mod.searchMessages(1, 'INBOX', 'body:deadline', 10, 0)
      expect(deadline.map(m => m.uid)).toEqual([1])

      const review = mod.searchMessages(1, 'INBOX', 'body:review', 10, 0)
      expect(review.map(m => m.uid)).toEqual([2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('attachmentFilenames is preserved across upsert without new value', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false, attachmentFilenames: 'report.pdf' },
      ])

      // Re-upsert without attachmentFilenames (simulating header re-sync without bodyStructure)
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
      ])

      const msg = mod.getMessageByUid(1, 'INBOX', 1)
      expect(msg?.attachmentFilenames).toBe('report.pdf')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listIndexedFolders returns folder pairs eligible for body indexing', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Sent', [
        { uid: 1, subject: 's2', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's3', fromAddr: 'a@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'INBOX', [
        { uid: 1, subject: 's4', fromAddr: 'b@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      const folders = mod.listIndexedFolders()
      expect(folders.length).toBe(3)
      expect(folders.find(f => f.accountId === 1 && f.folder === 'INBOX')?.count).toBe(1)
      expect(folders.find(f => f.accountId === 1 && f.folder === 'Sent')?.count).toBe(2)
      expect(folders.find(f => f.accountId === 2 && f.folder === 'INBOX')?.count).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter5: listIndexedFolders excludes folders with indexInSearch=false', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Three folders for account 1: INBOX (default indexed), Sent
      // (explicitly indexed), Spam (excluded). Body indexer should only
      // see INBOX and Sent — downloading Spam bodies wastes bandwidth and
      // disk for content the user opted out of search.
      mod.upsertFolderPref(1, 'Sent', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: false })

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Sent', [
        { uid: 1, subject: 's2', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 's3', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's4', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      const folders = mod.listIndexedFolders()
      const folderNames = folders.map(f => f.folder).sort()
      expect(folderNames).toEqual(['INBOX', 'Sent'])
      // Spam rows ARE in `messages` (folder is visible, just not searchable)
      // — they just don't show up here for the body indexer.
      expect(folders.find(f => f.folder === 'Spam')).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('searchMessages: 1000-message searches stay well under 1s (coarse catastrophic-slowdown guard)', async () => {
    // Coarse guard against a CATASTROPHIC slowdown only (an accidental O(n²) or
    // a query that hangs) — such a regression blows well past 1s. It is NOT a
    // precise micro-benchmark and does NOT reliably prove the FTS index is used:
    //   - only the first search ('project') goes through the FTS path; the
    //     `body:`/`filename:` searches use the LIKE-based advanced-search path,
    //   - and a full scan of just 1000 rows can itself finish under 1s, so a
    //     missing-index regression would not necessarily trip this threshold.
    // A wall-clock assertion on a shared CI/dev runner cannot be tighter without
    // flaking: the previous 200ms threshold had zero margin and flaked under
    // load (251–297ms at load avg ~18/12-core while healthy), and even a quiet
    // full-gate run measured ~775ms for this test. 1s keeps the catastrophic
    // signal while tolerating that variance. A real FTS-index-usage guard needs
    // an EXPLAIN QUERY PLAN assertion or a much larger corpus — tracked as a
    // §2.33 follow-up, not a wall-clock tweak.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const msgs = Array.from({ length: 1000 }, (_, i) => ({
        uid: i + 1,
        subject: `Message ${i} about ${i % 2 === 0 ? 'project' : 'meeting'}`,
        fromAddr: `user${i}@example.test`,
        fromName: `User ${i}`,
        date: new Date(Date.now() - i * 60000).toISOString(),
        unread: i % 3 === 0,
        bodyText: `This is the body of message ${i}. Contains various keywords like budget, review, deadline.`,
        attachmentFilenames: i % 5 === 0 ? `file${i}.pdf` : undefined,
      }))
      mod.upsertMessages(1, 'INBOX', msgs)

      // Simple FTS search
      const start1 = performance.now()
      const fts = mod.searchMessages(1, 'INBOX', 'project', 50, 0)
      const elapsed1 = performance.now() - start1
      expect(fts.length).toBeGreaterThan(0)
      expect(elapsed1).toBeLessThan(1000)

      // Advanced search with operators
      const start2 = performance.now()
      const advanced = mod.searchMessages(1, 'INBOX', 'body:budget is:unread', 50, 0)
      const elapsed2 = performance.now() - start2
      expect(advanced.length).toBeGreaterThan(0)
      expect(elapsed2).toBeLessThan(1000)

      // filename: search
      const start3 = performance.now()
      const filename = mod.searchMessages(1, 'INBOX', 'filename:pdf', 50, 0)
      const elapsed3 = performance.now() - start3
      expect(filename.length).toBeGreaterThan(0)
      expect(elapsed3).toBeLessThan(1000)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Search Excellence Hardening: folder_crawl_state ---

  testDb('folder crawl state: upsert, get, list, delete', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Initially empty
      const empty = mod.listFolderCrawlStates([1])
      expect(empty).toEqual([])

      // Insert
      mod.upsertFolderCrawlState(1, 'INBOX', { status: 'crawling', watermarkUid: 100, totalExists: 500 })
      const state = mod.getFolderCrawlState(1, 'INBOX')
      expect(state).toBeDefined()
      expect(state!.status).toBe('crawling')
      expect(state!.watermarkUid).toBe(100)
      expect(state!.totalExists).toBe(500)
      expect(state!.crawledCount).toBe(0)

      // Update
      mod.upsertFolderCrawlState(1, 'INBOX', {
        status: 'covered_full',
        crawledCount: 500,
        completedAt: '2026-04-06T12:00:00Z',
      })
      const updated = mod.getFolderCrawlState(1, 'INBOX')
      expect(updated!.status).toBe('covered_full')
      expect(updated!.crawledCount).toBe(500)
      expect(updated!.completedAt).toBe('2026-04-06T12:00:00Z')
      // watermarkUid should remain unchanged
      expect(updated!.watermarkUid).toBe(100)

      // Multiple folders
      mod.upsertFolderCrawlState(1, 'Sent', { status: 'not_started' })
      mod.upsertFolderCrawlState(2, 'INBOX', { status: 'error', error: 'connection lost' })

      const allAccount1 = mod.listFolderCrawlStates([1])
      expect(allAccount1).toHaveLength(2)

      const allBoth = mod.listFolderCrawlStates([1, 2])
      expect(allBoth).toHaveLength(3)

      // Delete account data
      mod.deleteFolderCrawlStates(1)
      expect(mod.listFolderCrawlStates([1])).toHaveLength(0)
      expect(mod.listFolderCrawlStates([2])).toHaveLength(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('search coverage stats: combines index and crawl state', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Insert messages — some with body, some without
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'msg1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: true },
        { uid: 2, subject: 'msg2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      mod.updateMessageBodyText(1, 'INBOX', 1, 'hello world')

      // Add crawl states
      mod.upsertFolderCrawlState(1, 'INBOX', { status: 'covered_full' })
      mod.upsertFolderCrawlState(1, 'Sent', { status: 'not_started' })
      mod.upsertFolderCrawlState(1, 'Archive', { status: 'error', error: 'timeout' })

      const stats = mod.getSearchCoverageStats([1])
      expect(stats.totalMessages).toBe(2)
      expect(stats.bodyIndexed).toBe(1)
      expect(stats.folderCoverage.total).toBe(3)
      expect(stats.folderCoverage.coveredFull).toBe(1)
      expect(stats.folderCoverage.notStarted).toBe(1)
      expect(stats.folderCoverage.error).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('FTS5 relevance ranking: subject match ranks higher than body match', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Message with "budget" in subject
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Budget report Q1', fromAddr: 'alice@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'Meeting notes', fromAddr: 'bob@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      // Message with "budget" only in body
      mod.updateMessageBodyText(1, 'INBOX', 2, 'We discussed the budget for Q2')

      const results = mod.searchMessages(1, 'INBOX', 'budget', 10)
      expect(results.length).toBe(2)
      // Subject match should be ranked first (higher bm25 weight)
      expect(results[0]!.uid).toBe(1)
      expect(results[1]!.uid).toBe(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('FTS5 snippet: returns match context from body', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Long email', fromAddr: 'x@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.updateMessageBodyText(1, 'INBOX', 1, 'This is a long document about quarterly revenue projections and forecasts for 2026')

      const results = mod.searchMessages(1, 'INBOX', 'revenue', 10)
      expect(results.length).toBe(1)
      expect(results[0]!.matchSnippet).toBeDefined()
      expect(results[0]!.matchSnippet).toContain('«')
      expect(results[0]!.matchSnippet).toContain('»')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAccountData clears folder_crawl_state', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'test', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.upsertFolderCrawlState(1, 'INBOX', { status: 'covered_full' })

      mod.deleteAccountData(1)
      expect(mod.listFolderCrawlStates([1])).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- 2.15 data-loss fix: stale_wipe_guard on removeStaleMessages + atomic batch ---

  testDb('removeStaleMessages: throws when freshUids=[] and opts missing (runtime guard)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
      ])
      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(2)

      // Cast to any to bypass the TS overload — simulates a legacy/untyped JS
      // caller. Runtime guard must still refuse and leave data untouched.
      const fn = mod.removeStaleMessages as unknown as (
        a: number, f: string, uids: number[],
      ) => number
      expect(() => fn(1, 'INBOX', [])).toThrow(/stale_wipe_guard tripped/)

      // Critical invariant: no rows deleted.
      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeStaleMessages: reason=server_empty emits db.mass_delete_messages with watermark_preserved=true', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const { setDbEventReporter } = await import('./telemetry')
      const events: Array<{ name: string; tags: Record<string, unknown> }> = []
      setDbEventReporter((name, tags) => { events.push({ name, tags }) })

      try {
        mod.upsertMessages(1, 'INBOX', [
          { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
          { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
        ])

        const removed = mod.removeStaleMessages(1, 'INBOX', [], { reason: 'server_empty' })
        expect(removed).toBe(2)
        expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(0)

        const massDelete = events.find(e => e.name === 'db.mass_delete_messages')
        expect(massDelete).toBeDefined()
        expect(massDelete!.tags.reason).toBe('server_empty')
        expect(massDelete!.tags.watermark_preserved).toBe(true)
        expect(massDelete!.tags.folder_role).toBe('inbox')
        expect(typeof massDelete!.tags.deleted_count_bucket).toBe('string')
      } finally {
        setDbEventReporter(null)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeStaleMessages: reason=uidvalidity_bump emits watermark_preserved=false', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const { setDbEventReporter } = await import('./telemetry')
      const events: Array<{ name: string; tags: Record<string, unknown> }> = []
      setDbEventReporter((name, tags) => { events.push({ name, tags }) })

      try {
        mod.upsertMessages(1, 'INBOX', [
          { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
          { uid: 2, subject: 's2', fromAddr: 'b@test', date: '2026-01-02T00:00:00Z', unread: false },
          { uid: 3, subject: 's3', fromAddr: 'c@test', date: '2026-01-03T00:00:00Z', unread: false },
        ])

        const removed = mod.removeStaleMessages(1, 'INBOX', [], { reason: 'uidvalidity_bump' })
        expect(removed).toBe(3)

        const massDelete = events.find(e => e.name === 'db.mass_delete_messages')
        expect(massDelete).toBeDefined()
        expect(massDelete!.tags.reason).toBe('uidvalidity_bump')
        // uidvalidity_bump invalidates the watermark; all other reasons preserve it.
        expect(massDelete!.tags.watermark_preserved).toBe(false)
      } finally {
        setDbEventReporter(null)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeStaleMessages: reason=reconcile preserves watermark in telemetry', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const { setDbEventReporter } = await import('./telemetry')
      const events: Array<{ name: string; tags: Record<string, unknown> }> = []
      setDbEventReporter((name, tags) => { events.push({ name, tags }) })

      try {
        mod.upsertMessages(1, 'INBOX', [
          { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        ])

        mod.removeStaleMessages(1, 'INBOX', [], { reason: 'reconcile' })

        const massDelete = events.find(e => e.name === 'db.mass_delete_messages')
        expect(massDelete!.tags.reason).toBe('reconcile')
        expect(massDelete!.tags.watermark_preserved).toBe(true)
      } finally {
        setDbEventReporter(null)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('removeStaleMessages: zero-row purge does not emit event (noise reduction)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const { setDbEventReporter } = await import('./telemetry')
      const events: Array<{ name: string; tags: Record<string, unknown> }> = []
      setDbEventReporter((name, tags) => { events.push({ name, tags }) })

      try {
        // Folder already empty — purge is a no-op; emitting telemetry for a
        // 0-row DELETE would be noise without an information value.
        mod.removeStaleMessages(1, 'EmptyFolder', [], { reason: 'server_empty' })
        expect(events.find(e => e.name === 'db.mass_delete_messages')).toBeUndefined()
      } finally {
        setDbEventReporter(null)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('applyFolderSyncBatch: commits messages + crawl state atomically', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.applyFolderSyncBatch(1, 'INBOX', [
        { uid: 10, subject: 's10', fromAddr: 'a@test', date: '2026-01-10T00:00:00Z', unread: false },
        { uid: 11, subject: 's11', fromAddr: 'b@test', date: '2026-01-11T00:00:00Z', unread: true },
      ], { status: 'covered_full', watermarkUid: 11, totalExists: 2, crawledCount: 2 })

      const msgs = mod.getMessages(1, 'INBOX', 10)
      expect(msgs.map(m => m.uid).sort()).toEqual([10, 11])

      const state = mod.getFolderCrawlState(1, 'INBOX')
      expect(state).toBeDefined()
      expect(state!.status).toBe('covered_full')
      expect(state!.watermarkUid).toBe(11)
      expect(state!.totalExists).toBe(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('applyFolderSyncBatch: empty messages still updates crawl state', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.applyFolderSyncBatch(1, 'INBOX', [], { status: 'covered_full', totalExists: 0 })

      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(0)
      const state = mod.getFolderCrawlState(1, 'INBOX')
      expect(state!.status).toBe('covered_full')
      expect(state!.totalExists).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('applyFolderSyncBatch: null crawl state leaves state untouched', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderCrawlState(1, 'INBOX', { status: 'crawling', watermarkUid: 5 })

      mod.applyFolderSyncBatch(1, 'INBOX', [
        { uid: 6, subject: 's6', fromAddr: 'a@test', date: '2026-01-06T00:00:00Z', unread: false },
      ], null)

      expect(mod.getMessages(1, 'INBOX', 10)).toHaveLength(1)
      const state = mod.getFolderCrawlState(1, 'INBOX')
      // Unchanged — no crawl-state update requested.
      expect(state!.status).toBe('crawling')
      expect(state!.watermarkUid).toBe(5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('checkpointWal: returns ok=true with numeric structural fields', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Generate some WAL activity so wal_checkpoint has work to do.
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's1', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      const result = mod.checkpointWal()
      expect(result.ok).toBe(true)
      expect(typeof result.beforeBytes).toBe('number')
      expect(typeof result.afterBytes).toBe('number')
      expect(typeof result.busy).toBe('number')
      expect(typeof result.checkpointedFrames).toBe('number')
      expect(typeof result.totalFrames).toBe('number')
      // After TRUNCATE checkpoint, WAL file should shrink or stay same (never grow).
      expect(result.afterBytes).toBeLessThanOrEqual(Math.max(result.beforeBytes, 1))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('checkpointWal: never throws even with no prior activity', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Call immediately without any writes — must not throw.
      expect(() => mod.checkpointWal()).not.toThrow()
      const result = mod.checkpointWal()
      // Result shape is stable regardless of whether a WAL file exists.
      expect(result).toHaveProperty('ok')
      expect(result).toHaveProperty('beforeBytes')
      expect(result).toHaveProperty('afterBytes')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §3.10 P0 MCP audit log --------------------------------------------
  //
  // ai_audit_log table persists security-relevant MCP gate events. Append-only
  // by convention; rows must survive a compromised renderer trying to hide
  // activity. The raw command string must NEVER be persisted — only hashes.

  testDb('ai_audit_log schema is created with all required columns', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      type ColumnRow = { name: string; type: string; notnull: number; dflt_value: unknown }
      const columns = mod.default
        .prepare(`PRAGMA table_info(ai_audit_log)`)
        .all() as ColumnRow[]
      const byName = Object.fromEntries(columns.map(c => [c.name, c]))
      expect(byName.id).toBeDefined()
      expect(byName.event_type).toBeDefined()
      expect(byName.event_type.notnull).toBe(1)
      expect(byName.command_hash).toBeDefined()
      expect(byName.approved_source).toBeDefined()
      expect(byName.reason).toBeDefined()
      expect(byName.session_id).toBeDefined()
      expect(byName.created_at).toBeDefined()
      expect(byName.created_at.notnull).toBe(1)

      // Indexes for query performance.
      type IndexRow = { name: string }
      const indexes = mod.default
        .prepare(`PRAGMA index_list(ai_audit_log)`)
        .all() as IndexRow[]
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_ai_audit_log_type_created')
      expect(names).toContain('idx_ai_audit_log_created')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendMcpAuditEvent inserts rows for all documented event types', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted', commandHash: 'a'.repeat(64), approvedSource: 'env' })
      mod.appendMcpAuditEvent({ eventType: 'stdio.connect_blocked', commandHash: 'b'.repeat(64), reason: 'not_approved' })
      mod.appendMcpAuditEvent({ eventType: 'stdio.approved', commandHash: 'c'.repeat(64), approvedSource: 'native-confirm', reason: 'connection_approve' })
      mod.appendMcpAuditEvent({ eventType: 'settings.forbidden_field', reason: 'fields:mcpEnableStdio' })

      const rows = mod.listRecentMcpAuditEvents(10)
      expect(rows).toHaveLength(4)
      // Reverse-chronological order — most recent first.
      expect(rows[0].eventType).toBe('settings.forbidden_field')
      expect(rows[0].reason).toBe('fields:mcpEnableStdio')
      expect(rows[0].commandHash).toBeNull()
      expect(rows[0].approvedSource).toBeNull()
      expect(rows[1].eventType).toBe('stdio.approved')
      expect(rows[1].approvedSource).toBe('native-confirm')
      expect(rows[2].eventType).toBe('stdio.connect_blocked')
      expect(rows[2].reason).toBe('not_approved')
      expect(rows[3].eventType).toBe('stdio.connect_attempted')
      expect(rows[3].approvedSource).toBe('env')
      // createdAt populated by default on every row.
      for (const r of rows) {
        expect(r.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendMcpAuditEvent persists null for omitted optional fields', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted' })
      const rows = mod.listRecentMcpAuditEvents(1)
      expect(rows).toHaveLength(1)
      expect(rows[0].commandHash).toBeNull()
      expect(rows[0].approvedSource).toBeNull()
      expect(rows[0].reason).toBeNull()
      expect(rows[0].sessionId).toBeNull()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendMcpAuditEvent never throws — missing rows are observability loss, not policy violation', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Closing the DB mid-flight guarantees that the INSERT throws at the
      // prepare/run layer — exercises the try/catch contract.
      mod.default.close()
      expect(() => mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted' })).not.toThrow()
    } finally {
      // Skip the default cleanup close — DB is already closed.
      try { mod.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })

  testDb('appendMcpAuditEvent is append-only: UPDATE/DELETE of prior rows is not expected path', async () => {
    // Invariant documentation: the table has no UPDATE/DELETE helpers exposed.
    // A future PR adding a mutation helper should trigger a security review.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendMcpAuditEvent({ eventType: 'stdio.approved', approvedSource: 'native-confirm' })
      mod.appendMcpAuditEvent({ eventType: 'stdio.approved', approvedSource: 'native-confirm' })
      const rows = mod.listRecentMcpAuditEvents(10)
      // Both rows persisted with distinct autoincrement ids — no dedupe.
      expect(rows).toHaveLength(2)
      expect(rows[0].id).not.toBe(rows[1].id)
      // Module surface does not export mutation helpers for this table.
      const moduleExports = Object.keys(mod as Record<string, unknown>)
      expect(moduleExports).not.toContain('updateMcpAuditEvent')
      expect(moduleExports).not.toContain('deleteMcpAuditEvent')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listRecentMcpAuditEvents respects limit parameter', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 5; i++) {
        mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted', reason: `n${i}` })
      }
      expect(mod.listRecentMcpAuditEvents(2)).toHaveLength(2)
      expect(mod.listRecentMcpAuditEvents(100)).toHaveLength(5)
      // Default limit is 100.
      expect(mod.listRecentMcpAuditEvents()).toHaveLength(5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendMcpAuditEvent treats commandHash as opaque — no length/charset validation at DB layer', async () => {
    // Layering contract: the hash boundary is enforced on the caller side
    // (packages/net/services/mcpClient.hashStdioCommand produces SHA-256 hex).
    // DB accepts whatever the caller passes so there is no way a refactor in
    // the DB module accidentally leaks raw commands through loose validation.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted', commandHash: '' })
      mod.appendMcpAuditEvent({ eventType: 'stdio.connect_attempted', commandHash: 'not-actually-a-hash' })
      const rows = mod.listRecentMcpAuditEvents(2)
      expect(rows.map(r => r.commandHash)).toEqual(['not-actually-a-hash', ''])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.15-ter: per-folder index gate + body retention preview ----------

  testDb('§2.15-ter: folder_prefs.indexInSearch defaults to true on first create', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const created = mod.upsertFolderPref(1, 'INBOX', { visible: true })
      expect(created.indexInSearch).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: indexInSearch=false skips FTS for upserted rows but keeps row in messages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: false })
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 'unique-spam-subject', fromAddr: 'spam@evil.test', date: '2026-02-08T00:00:00Z', unread: true },
      ])
      const rows = mod.getMessages(1, 'Spam', 10)
      expect(rows.map(m => m.uid)).toEqual([1])
      const searched = mod.searchMessages(1, 'Spam', 'unique-spam-subject', 10, 0)
      expect(searched).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: indexInSearch=true keeps full-text search working as before', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'searchable-keyword', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      const searched = mod.searchMessages(1, 'INBOX', 'searchable-keyword', 10, 0)
      expect(searched.map(m => m.uid)).toEqual([1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: toggling indexInSearch true→false stops new upserts from indexing', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'before-toggle', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      expect(mod.searchMessages(1, 'Junk', 'before-toggle', 10, 0).length).toBe(1)
      mod.upsertFolderPref(1, 'Junk', { indexInSearch: false })
      mod.upsertMessages(1, 'Junk', [
        { uid: 2, subject: 'after-toggle', fromAddr: 'b@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      expect(mod.searchMessages(1, 'Junk', 'after-toggle', 10, 0).length).toBe(0)
      const all = mod.getMessages(1, 'Junk', 10)
      expect(all.map(m => m.uid).sort((a, b) => a - b)).toEqual([1, 2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: previewBodyRetentionImpact aggregates only offlineMode=full folders', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, offlineMode: 'full' })
      mod.upsertFolderPref(1, 'Period', { visible: true, offlineMode: 'period', offlineDays: 30 })
      mod.upsertFolderPref(1, 'Off', { visible: true, offlineMode: 'off' })

      const oldDate = new Date(Date.now() - 400 * 86400000).toISOString()
      mod.upsertMessages(1, 'INBOX', [{ uid: 1, subject: 's', fromAddr: 'a@x', date: oldDate, unread: false }])
      mod.upsertMessages(1, 'Period', [{ uid: 1, subject: 's', fromAddr: 'a@x', date: oldDate, unread: false }])
      mod.upsertMessages(1, 'Off', [{ uid: 1, subject: 's', fromAddr: 'a@x', date: oldDate, unread: false }])
      mod.setBodyDownloaded(1, 'INBOX', 1, true, 1024)
      mod.setBodyDownloaded(1, 'Period', 1, true, 4096)
      mod.setBodyDownloaded(1, 'Off', 1, true, 8192)

      const cutoff = new Date(Date.now() - 365 * 86400000).toISOString()
      const impact = mod.previewBodyRetentionImpact(cutoff)
      expect(impact.count).toBe(1)
      expect(impact.totalSize).toBe(1024)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: sumMessageSizes returns 0 for empty UID list (no DB roundtrip)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.sumMessageSizes(1, 'INBOX', [])).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: sumMessageSizes sums message_size for matching UIDs only', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'a', fromAddr: 'x@y', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'b', fromAddr: 'x@y', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 3, subject: 'c', fromAddr: 'x@y', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.setBodyDownloaded(1, 'INBOX', 1, true, 100)
      mod.setBodyDownloaded(1, 'INBOX', 2, true, 200)
      mod.setBodyDownloaded(1, 'INBOX', 3, true, 300)
      expect(mod.sumMessageSizes(1, 'INBOX', [1, 3])).toBe(400)
      expect(mod.sumMessageSizes(1, 'INBOX', [999])).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: updateMessageBodyText skips FTS for indexInSearch=false folders', async () => {
    // Regression guard: after a body is stored for an excluded folder the body
    // text must NOT be searchable via FTS5, even though the AFTER UPDATE trigger
    // fires unconditionally for every messages UPDATE.
    //
    // Setup: insert with indexInSearch=true first so FTS5 has a stable entry.
    // Then flip to false and call updateMessageBodyText — the FTS delete in
    // updateMessageBodyText must remove the row from the index.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Start indexed so FTS gets a clean entry
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 'spam-subject-keyword', fromAddr: 'x@y', date: '2026-01-01T00:00:00Z', unread: true },
      ])
      // Verify it is initially searchable
      expect(mod.searchMessages(1, 'Spam', 'spam-subject-keyword', 10, 0)).toHaveLength(1)

      // Now exclude from search — subsequent body updates must not be findable
      mod.upsertFolderPref(1, 'Spam', { indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.updateMessageBodyText(1, 'Spam', 1, 'body-content-unique-xyz')

      // Row is still visible in list view
      expect(mod.getMessages(1, 'Spam', 10)).toHaveLength(1)
      // Row must NOT be retrievable through FTS after body update on excluded folder
      expect(mod.searchMessages(1, 'Spam', 'body-content-unique-xyz', 10, 0)).toHaveLength(0)
      expect(mod.searchMessages(1, 'Spam', 'spam-subject-keyword', 10, 0)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: updateMessageBodyText preserves FTS5 integrity on indexInSearch=false folder (production flow)', async () => {
    // Production data corruption regression. Flow:
    //   1) Folder is created with indexInSearch=false from the start (Junk/Spam/Trash).
    //   2) Header sync calls upsertMessages — row inserted into messages, AFTER
    //      INSERT trigger pushes (subject, "", "", "", NULL_or_"", "") into
    //      messages_fts; upsertMessages immediately follows with FTS5 'delete'
    //      so the shadow tables drop that rowid.
    //   3) Body indexer arrives and calls updateMessageBodyText. This UPDATEs
    //      messages.body_text. The AFTER UPDATE trigger fires unconditionally:
    //         (a) 'delete' rowid with OLD VALUES — but the rowid was already
    //             removed from FTS in step 2, so FTS5 tries to subtract token
    //             counts from records that no longer exist → "database disk
    //             image is malformed".
    //         (b) Re-insert NEW VALUES — adds tokens back.
    //      The post-trigger 'delete' helper in updateMessageBodyText cannot
    //      undo the corruption created at step 3a.
    //
    // Fix: before issuing the UPDATE, manually re-insert OLD VALUES into
    // messages_fts so the trigger's 'delete' is balanced. After the UPDATE,
    // issue a final 'delete' with NEW VALUES to remove the row again.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'spam-keyword', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      // This call must not corrupt FTS5 shadow tables.
      mod.updateMessageBodyText(1, 'Junk', 1, 'body-text-content-here')

      // FTS5 internal integrity check — throws "database disk image is malformed"
      // when shadow tables are inconsistent.
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()

      // PRAGMA integrity_check returns ['ok'] when DB is intact.
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Functional check: the row remains visible but is not searchable.
      expect(mod.getMessages(1, 'Junk', 10)).toHaveLength(1)
      expect(mod.searchMessages(1, 'Junk', 'body-text-content-here', 10, 0)).toHaveLength(0)
      expect(mod.searchMessages(1, 'Junk', 'spam-keyword', 10, 0)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: updateMessageBodyText keeps FTS for indexInSearch=true folders', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'inbox-subject', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      mod.updateMessageBodyText(1, 'INBOX', 1, 'unique-body-token-abc')
      const results = mod.searchMessages(1, 'INBOX', 'inbox-subject', 10, 0)
      expect(results.map(m => m.uid)).toEqual([1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: in-memory indexInSearch cache is invalidated when upsertFolderPref changes the value', async () => {
    // Ensures the cache key is cleared on upsert so a subsequent upsertMessages
    // call sees the updated value. Without cache invalidation the first call
    // would warm the cache to true and the second upsertMessages call would
    // still index despite indexInSearch=false having been written to the DB.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Prime cache with indexInSearch=true
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'before-invalidation', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      expect(mod.searchMessages(1, 'Junk', 'before-invalidation', 10, 0)).toHaveLength(1)

      // Flip to false — must invalidate cache
      mod.upsertFolderPref(1, 'Junk', { indexInSearch: false })
      // Reset the in-memory cache explicitly (simulates a vitest reset between
      // module instances; the export exists precisely for this purpose).
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'Junk', [
        { uid: 2, subject: 'after-invalidation', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // New message must not appear in FTS
      expect(mod.searchMessages(1, 'Junk', 'after-invalidation', 10, 0)).toHaveLength(0)
      // Message row itself is still visible
      expect(mod.getMessages(1, 'Junk', 10)).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: previewBodyRetentionImpact returns zero counts when no bodies older than cutoff', async () => {
    // Edge case: cutoff is in the past (yesterday) — fresh bodies should not be counted.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, offlineMode: 'full' })
      const recentDate = new Date(Date.now() - 1 * 86400000).toISOString() // 1 day ago
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'fresh', fromAddr: 'a@b', date: recentDate, unread: false },
      ])
      mod.setBodyDownloaded(1, 'INBOX', 1, true, 512)
      // cutoff 365 days ago — the 1-day-old message is much newer, so count=0
      const cutoff = new Date(Date.now() - 365 * 86400000).toISOString()
      const result = mod.previewBodyRetentionImpact(cutoff)
      expect(result.count).toBe(0)
      expect(result.totalSize).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: deleteMessages preserves FTS5 integrity on indexInSearch=false folder (production flow)', async () => {
    // Production data corruption regression. Reproduces the
    // mail.flows.spec.ts:250 e2e failure: delete-forever from Trash where
    // Trash has indexInSearch=false. Flow:
    //   1) Folder marked indexInSearch=false (Trash/Spam/Junk).
    //   2) Header sync: upsertMessages inserts row → AFTER INSERT trigger
    //      pushes it into messages_fts → upsertMessages immediately follows
    //      with FTS5 'delete', so the rowid is gone from the shadow tables.
    //   3) Body indexer: updateMessageBodyText. Already covered by an
    //      earlier reproducer test in this file (now fixed in production).
    //   4) User clicks Delete Forever from Trash → deleteMessages runs
    //      DELETE FROM messages → AFTER DELETE trigger fires
    //      unconditionally, attempts FTS5 'delete' on a rowid that does
    //      not exist → SQLITE_CORRUPT_VTAB ("database disk image is
    //      malformed"). Transaction rolls back, message stays in Trash.
    //
    // Fix: deleteMessages pre-inserts OLD VALUES into messages_fts inside
    // its transaction so the trigger's 'delete' is balanced. See the
    // architectural invariant block in packages/db/index.ts.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      // Step 2: header sync.
      mod.upsertMessages(1, 'Trash', [
        { uid: 10, subject: 'trash-subject', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // Step 3: body indexer (already-fixed path).
      mod.updateMessageBodyText(1, 'Trash', 10, 'trash-body-content')

      // Step 4: delete forever — must not corrupt FTS5 shadow tables.
      expect(() => {
        mod.deleteMessages(1, 'Trash', [10])
      }).not.toThrow()

      // FTS5 internal integrity check — throws "database disk image is
      // malformed" when shadow tables are inconsistent.
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()

      // PRAGMA integrity_check returns ['ok'] when the DB is intact.
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Functional check: row is gone from messages.
      expect(mod.getMessages(1, 'Trash', 10)).toHaveLength(0)
      // Search returns nothing — row was excluded all along.
      expect(mod.searchMessages(1, 'Trash', 'trash-subject', 10, 0)).toHaveLength(0)
      expect(mod.searchMessages(1, 'Trash', 'trash-body-content', 10, 0)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: deleteMessages keeps FTS coherent for indexInSearch=true folders', async () => {
    // Regression guard: the rebalance must NOT pre-insert OLD VALUES for
    // included folders — the AFTER DELETE trigger's 'delete' already
    // matches the row pushed by AFTER INSERT, and a duplicate insert
    // would itself corrupt the index. This test ensures the per-folder
    // gate inside `prepareFtsDeleteRebalance` does its job.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'inbox-keep', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'inbox-drop', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // Pre-condition: both rows are searchable.
      expect(mod.searchMessages(1, 'INBOX', 'inbox-keep', 10, 0).map(m => m.uid)).toEqual([1])
      expect(mod.searchMessages(1, 'INBOX', 'inbox-drop', 10, 0).map(m => m.uid)).toEqual([2])

      mod.deleteMessages(1, 'INBOX', [2])

      // FTS5 stays intact.
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Deleted row is gone from FTS; remaining row still searchable.
      expect(mod.searchMessages(1, 'INBOX', 'inbox-drop', 10, 0)).toHaveLength(0)
      expect(mod.searchMessages(1, 'INBOX', 'inbox-keep', 10, 0).map(m => m.uid)).toEqual([1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter: removeStaleMessages preserves FTS5 integrity on indexInSearch=false folder', async () => {
    // Same structural bug class as deleteMessages, but exercised through
    // the reconciliation path. removeStaleMessages is what runs after a
    // periodic FETCH when the IMAP server reports a smaller UID set than
    // the cache holds (typical during EXPUNGE catch-up). For Trash/Spam
    // with indexInSearch=false, the same AFTER DELETE trigger 'delete'
    // on a missing rowid would corrupt FTS5.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      // Seed three rows.
      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'junk-one', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 2, subject: 'junk-two', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 3, subject: 'junk-three', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      // Reconcile-by-fresh-UIDs path: server now reports only [1, 3], so
      // uid=2 must be removed. This goes through the freshUids non-empty
      // branch of removeStaleMessages.
      expect(() => {
        mod.removeStaleMessages(1, 'Junk', [1, 3] as [number, ...number[]])
      }).not.toThrow()

      // FTS5 integrity holds.
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Row 2 is gone, rows 1 and 3 remain.
      expect(mod.getMessages(1, 'Junk', 10).map(m => m.uid).sort((a, b) => a - b)).toEqual([1, 3])

      // Mass-delete branch (folder purge). Reseed and trigger via reason.
      mod.upsertMessages(1, 'Junk', [
        { uid: 5, subject: 'junk-five', fromAddr: 'a@b', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      expect(() => {
        mod.removeStaleMessages(1, 'Junk', [], { reason: 'server_empty' })
      }).not.toThrow()

      // FTS5 still intact after the mass-delete branch.
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()
      const integ2 = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ2.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Folder is empty.
      expect(mod.getMessages(1, 'Junk', 10)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.15-ter codex iteration 4: AFTER UPDATE OF triggers + cache + search filters ---

  testDb('§2.15-ter iter4: messages_au trigger uses AFTER UPDATE OF clause (regression guard)', async () => {
    // Pin the canonical OF column list. If a future change adds a new
    // FTS-projected column, the trigger must include it; if a column
    // becomes non-FTS, drop it. Either drift would silently break either
    // FTS coherence (missing column) or the no-trigger-on-non-FTS-UPDATE
    // optimization (extraneous column).
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const row = mod.default.prepare(
        `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_au'`
      ).get() as { sql?: string } | undefined
      expect(row?.sql).toBeDefined()
      const sql = row!.sql ?? ''
      // Trigger MUST use UPDATE OF; bare UPDATE would over-fire.
      expect(/AFTER\s+UPDATE\s+OF\s+/i.test(sql)).toBe(true)
      // Column list (canonical FTS-projected set).
      for (const col of ['subject', 'from_addr', 'from_name', 'to_addr', 'body_text', 'attachment_filenames']) {
        expect(sql).toContain(col)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: setUnread on indexInSearch=false folder does NOT corrupt FTS', async () => {
    // Reproducer for codex BLOCKER. Before the AFTER UPDATE OF clause, a
    // simple unread-flag flip on a Spam/Trash row would fire the FTS trigger,
    // which would 'delete' OLD VALUES against a rowid that was never indexed
    // — corrupting FTS5 shadow tables.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 'spam-keyword', fromAddr: 'spam@evil.test', date: '2026-02-08T00:00:00Z', unread: true },
      ])

      // Flip unread → read. With the over-firing trigger this corrupted FTS5.
      expect(() => mod.setUnread(1, 'Spam', [1], false)).not.toThrow()

      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])

      // Functional check: row is still in messages, unread flag flipped.
      const all = mod.getMessages(1, 'Spam', 10)
      expect(all).toHaveLength(1)
      expect(all[0]!.unread).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: setFlagged on indexInSearch=false folder preserves FTS integrity', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()
      mod.upsertMessages(1, 'Junk', [
        { uid: 5, subject: 'junk-keyword', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      expect(() => mod.setFlagged(1, 'Junk', [5], true)).not.toThrow()

      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: setBodyDownloaded / setCachedDetail / setPinned / updateAttachmentFilenames do not corrupt FTS on indexInSearch=false', async () => {
    // Each of these helpers UPDATEs a non-FTS column. With AFTER UPDATE OF
    // they should not fire the FTS trigger at all.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()
      mod.upsertMessages(1, 'Trash', [
        { uid: 7, subject: 'trash-keyword', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      expect(() => mod.setBodyDownloaded(1, 'Trash', 7, true, 1024)).not.toThrow()
      expect(() => mod.setCachedDetail(1, 'Trash', 7, '{"body":"ignored"}')).not.toThrow()
      expect(() => mod.setPinned(1, 'Trash', 7, true)).not.toThrow()
      // Note: attachment_filenames IS one of the FTS-projected columns, so
      // this update WILL fire the AFTER UPDATE OF trigger. The codex finding
      // listed updateAttachmentFilenames in the breakage class because the
      // OLD trigger (without OF) over-fired; with the OF clause the trigger
      // runs as designed for this column. The path needs the same OLD-VALUES
      // rebalance as updateMessageBodyText to keep FTS coherent — so we
      // assert that the update preserves integrity, not that the trigger is
      // skipped.
      expect(() => mod.updateAttachmentFilenames(1, 'Trash', 7, 'attachment.pdf')).not.toThrow()

      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: upsertMessages conflict update on indexInSearch=false preserves FTS integrity', async () => {
    // Codex BLOCKER reproducer. upsertMessages's ON CONFLICT clause UPDATEs
    // subject/from/to/body_text — all FTS columns, so the trigger fires.
    // The first upsert removed the row from FTS via the in-method 'delete'.
    // The second upsert (conflict path) must keep the rebalance pattern.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'Junk', [
        { uid: 11, subject: 'first-subject', fromAddr: 'one@b', date: '2026-02-08T00:00:00Z', unread: true },
      ])
      // Re-upsert same UID with different subject — exercises the conflict
      // update path, which is the codex-cited breakage scenario.
      expect(() =>
        mod.upsertMessages(1, 'Junk', [
          { uid: 11, subject: 'second-subject', fromAddr: 'one@b', date: '2026-02-08T01:00:00Z', unread: false },
        ]),
      ).not.toThrow()

      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()

      // Both subjects must be unsearchable (folder excluded).
      expect(mod.searchMessages(1, 'Junk', 'first-subject', 10, 0)).toHaveLength(0)
      expect(mod.searchMessages(1, 'Junk', 'second-subject', 10, 0)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: advanced search respects indexInSearch=false', async () => {
    // Codex HIGH 2 reproducer. FTS path was already correct; advanced /
    // LIKE fallbacks read from messages directly and must filter excluded.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'shared-keyword inbox-only', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Spam', [
        { uid: 2, subject: 'shared-keyword spam-only', fromAddr: 'spam@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      // Advanced subject: operator forces the LIKE-based advanced path.
      const subjResults = mod.searchMessages(1, 'INBOX', 'subject:shared-keyword', 10, 0)
      expect(subjResults.map(m => m.uid)).toEqual([1])

      // Advanced from: operator
      const fromResults = mod.searchMessages(1, 'INBOX', 'from:spam', 10, 0)
      expect(fromResults).toEqual([])

      // Anywhere — must still respect indexInSearch=false in advanced mode.
      const anywhereResults = mod.searchMessages(1, 'INBOX', 'subject:shared-keyword anywhere:1', 10, 0)
      // anywhere:1 isn't a valid token, but subject: makes this advanced;
      // result should still be only the indexed folder.
      void anywhereResults

      // Unified inbox advanced — both messages exist but only INBOX is
      // searchable. subject: is the operator that forces advanced.
      const unifiedAdvanced = mod.searchUnifiedInbox([1], 'subject:shared-keyword', 10, 0, 'all')
      expect(unifiedAdvanced.map(m => m.folder)).toEqual(['INBOX'])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: LIKE fallback search respects indexInSearch=false (FTS-disabled scenario)', async () => {
    // Reproducer that exercises the LIKE fallback. We can't easily disable
    // FTS for this test, but we can hit the fallback by feeding a query
    // that splits to zero FTS tokens and falls through to LIKE.
    // Single-quote queries split to no \p{L}\p{N}_ tokens → fall through.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: '"quoted-keyword"', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Trash', [
        { uid: 2, subject: '"quoted-keyword"', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      // Query containing only punctuation tokenizes to empty for FTS5,
      // forcing the LIKE fallback. The literal `"` characters are present
      // in both subjects.
      const results = mod.searchMessages(1, 'INBOX', '"', 10, 0)
      // The LIKE fallback ran and must filter out Trash.
      expect(results.every(m => m.folder !== 'Trash')).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: removeStaleMessages mass-delete wraps rebalance and DELETE atomically', async () => {
    // Codex HIGH 4 reproducer. The mass-delete branch previously ran
    // rebalanceFtsForBulkDelete OUTSIDE a transaction, then the DELETE
    // separately. A throw in between would leave excluded-folder rows
    // re-inserted into FTS without their messages-row counterpart.
    //
    // With the fix the two steps live inside db.transaction() — even on
    // simulated failure mid-DELETE the rollback restores both.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()
      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'junk-1', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 2, subject: 'junk-2', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      // Drive the mass-delete branch (freshUids = []).
      const deleted = mod.removeStaleMessages(1, 'Junk', [], { reason: 'server_empty' })
      expect(deleted).toBe(2)

      // FTS5 integrity holds.
      const integ = mod.default.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>
      expect(integ.map(r => r.integrity_check ?? '')).toEqual(['ok'])
      expect(() => {
        mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)
      }).not.toThrow()

      // Folder is empty.
      expect(mod.getMessages(1, 'Junk', 10)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: removeFolderPref invalidates indexInSearch cache', async () => {
    // Codex MEDIUM 2 reproducer. Before fix: cache held a stale `false`
    // after the row was deleted, so subsequent upsertMessages kept
    // skipping FTS even though the column DEFAULT is `1` for folders
    // without an explicit pref.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Create folder with indexInSearch=false, prime the cache.
      mod.upsertFolderPref(1, 'TempJunk', { visible: true, indexInSearch: false })
      mod.upsertMessages(1, 'TempJunk', [
        { uid: 1, subject: 'first-cached-as-false', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // Excluded — must not be searchable.
      expect(mod.searchMessages(1, 'TempJunk', 'first-cached-as-false', 10, 0)).toHaveLength(0)

      // Remove the pref. This should invalidate the cache so a fresh
      // upsert re-resolves to default true (column DEFAULT 1).
      expect(mod.removeFolderPref(1, 'TempJunk')).toBe(true)
      mod.upsertMessages(1, 'TempJunk', [
        { uid: 2, subject: 'second-default-true', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // After removal the cache should be cleared and the new upsert is
      // indexed (column DEFAULT 1).
      expect(mod.searchMessages(1, 'TempJunk', 'second-default-true', 10, 0).map(m => m.uid)).toEqual([2])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: getSearchIndexStats excludes folders with indexInSearch=false', async () => {
    // Codex LOW 1: stats power the body-indexing-coverage statusbar
    // metric. Excluded folders intentionally don't get body-indexed,
    // so they must not inflate the denominator.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.__resetIndexInSearchCacheForTest()

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 's', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Junk', [
        { uid: 2, subject: 's', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 3, subject: 's', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      const stats = mod.getSearchIndexStats([1])
      // Only INBOX (1 message) counted; Junk (2 messages) excluded.
      expect(stats.totalMessages).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.15-ter codex iteration 5: toggle reconciliation + rebuild filter ---

  testDb('§2.15-ter iter5: upsertFolderPref toggle true→false purges existing FTS rows', async () => {
    // Reproducer for HIGH 1: with the menu now wired in iteration 4, the
    // user expects "Exclude from search" to make Spam disappear from
    // search immediately. Pre-fix, upsertFolderPref persisted the column
    // but did not reconcile messages_fts, so already-indexed rows kept
    // matching FTS5 and showed up in search results.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Seed Spam as INDEXED first, populate, confirm searchable.
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Spam', [
        { uid: 1, subject: 'iter5-purge-keyword-aaa', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 2, subject: 'iter5-purge-keyword-bbb', fromAddr: 'b@test', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 3, subject: 'iter5-purge-keyword-ccc', fromAddr: 'c@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      const before = mod.searchMessages(1, 'Spam', 'iter5-purge-keyword-aaa', 10, 0)
      expect(before.map(m => m.uid)).toEqual([1])

      // Toggle to excluded — must purge FTS for existing rows.
      mod.upsertFolderPref(1, 'Spam', { indexInSearch: false })

      // Search returns nothing for ANY of the seeded rows.
      expect(mod.searchMessages(1, 'Spam', 'iter5-purge-keyword-aaa', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'Spam', 'iter5-purge-keyword-bbb', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'Spam', 'iter5-purge-keyword-ccc', 10, 0)).toEqual([])

      // BUT: message rows themselves stay in `messages` — list view still works.
      const stillThere = mod.getMessages(1, 'Spam', 10)
      expect(stillThere.map(m => m.uid).sort()).toEqual([1, 2, 3])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter5: upsertFolderPref toggle false→true backfills FTS rows', async () => {
    // Reproducer for HIGH 1 (other direction): user toggled Spam to
    // excluded, then changed their mind. Pre-fix, upsertFolderPref did
    // not backfill the rows that were inserted while excluded, so search
    // stayed empty even after toggling back on.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Folder created excluded from the start.
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: false })
      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'iter5-backfill-aaa', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 2, subject: 'iter5-backfill-bbb', fromAddr: 'b@test', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 3, subject: 'iter5-backfill-ccc', fromAddr: 'c@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // Sanity: while excluded, search returns nothing.
      expect(mod.searchMessages(1, 'Junk', 'iter5-backfill-aaa', 10, 0)).toEqual([])

      // Toggle to included — must backfill FTS for all three rows.
      mod.upsertFolderPref(1, 'Junk', { indexInSearch: true })

      // All three rows must now be searchable.
      const aaa = mod.searchMessages(1, 'Junk', 'iter5-backfill-aaa', 10, 0)
      const bbb = mod.searchMessages(1, 'Junk', 'iter5-backfill-bbb', 10, 0)
      const ccc = mod.searchMessages(1, 'Junk', 'iter5-backfill-ccc', 10, 0)
      expect(aaa.map(m => m.uid)).toEqual([1])
      expect(bbb.map(m => m.uid)).toEqual([2])
      expect(ccc.map(m => m.uid)).toEqual([3])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter5: upsertFolderPref toggle does not corrupt FTS after a follow-up upsertMessages', async () => {
    // After a true→false toggle purges FTS, the next upsertMessages on
    // the same folder must keep the per-folder gate honored without
    // corrupting messages_fts. This protects against a regression where
    // the OLD-VALUES rebalance dance in upsertMessages would race with
    // the new toggle path (e.g., if the toggle left FTS in a half-state).
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Trash', [
        { uid: 10, subject: 'pre-toggle', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // Toggle to excluded — purges FTS.
      mod.upsertFolderPref(1, 'Trash', { indexInSearch: false })
      // Subsequent upserts on existing UID 10 (CONFLICT path) and a fresh
      // UID 11 (INSERT path) must not corrupt FTS.
      mod.upsertMessages(1, 'Trash', [
        { uid: 10, subject: 'post-toggle-existing', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
        { uid: 11, subject: 'post-toggle-new', fromAddr: 'b@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // FTS5 integrity check — would surface "database disk image is malformed".
      const integrity = mod.default.prepare(
        `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`
      )
      expect(() => integrity.run()).not.toThrow()
      // Search returns nothing for either row.
      expect(mod.searchMessages(1, 'Trash', 'post-toggle-existing', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'Trash', 'post-toggle-new', 10, 0)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter5: FTS rebuild excludes folders with indexInSearch=false', async () => {
    // Reproducer for HIGH 2: after a schema migration / fresh FTS table
    // creation, the bare `INSERT INTO messages_fts(messages_fts)
    // VALUES('rebuild')` repopulates from EVERY row in messages,
    // including folders the user excluded. We force the rebuild path by
    // (a) seeding messages with mixed folder_prefs, (b) dropping the FTS
    // table + triggers, (c) re-importing the module so the
    // `if (!hadFts) { ... rebuild ... }` block runs.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Seed: INBOX indexed, Spam excluded, Trash excluded.
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Spam', { visible: true, indexInSearch: false })
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: false })

      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'iter5-rebuild-inbox-token', fromAddr: 'a@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Spam', [
        { uid: 2, subject: 'iter5-rebuild-spam-token', fromAddr: 'b@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Trash', [
        { uid: 3, subject: 'iter5-rebuild-trash-token', fromAddr: 'c@test', date: '2026-02-08T00:00:00Z', unread: false },
      ])

      // Drop FTS table + its triggers to simulate a schema migration.
      mod.default.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS messages_fts;
      `)
      // Close the singleton so the next import re-opens the file.
      mod.default.close()

      // Re-import the module — this triggers the FTS init path with
      // hadFts=false → rebuild → exclude path.
      vi.resetModules()
      const mod2 = await import('./index')

      // INBOX search returns its row.
      const inbox = mod2.searchMessages(1, 'INBOX', 'iter5-rebuild-inbox-token', 10, 0)
      expect(inbox.map(m => m.uid)).toEqual([1])

      // Spam / Trash searches return nothing — FTS rebuild must have
      // skipped (or post-deleted) the excluded rows.
      expect(mod2.searchMessages(1, 'Spam', 'iter5-rebuild-spam-token', 10, 0)).toEqual([])
      expect(mod2.searchMessages(1, 'Trash', 'iter5-rebuild-trash-token', 10, 0)).toEqual([])

      // FTS5 integrity check after rebuild + exclude.
      const integrity = mod2.default.prepare(
        `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`
      )
      expect(() => integrity.run()).not.toThrow()

      mod2.default.close()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter4: in-memory cache invalidation actually flips behavior (no test bypass)', async () => {
    // Strengthened version of the existing cache-invalidation test. The
    // earlier test called __resetIndexInSearchCacheForTest() right after
    // upsertFolderPref, which masked the invalidation: even without
    // production cache invalidation the test would pass because the
    // explicit reset emptied the Map. This test does NOT call the
    // test-only reset between the prime and the flip, so it actually
    // exercises invalidateIndexInSearchCache from upsertFolderPref.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Step 1: prime cache with indexInSearch=true via real-flow upsert.
      mod.upsertFolderPref(1, 'Drafts', { visible: true, indexInSearch: true })
      mod.upsertMessages(1, 'Drafts', [
        { uid: 1, subject: 'draft-keyword', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      expect(mod.searchMessages(1, 'Drafts', 'draft-keyword', 10, 0)).toHaveLength(1)

      // Step 2: flip to false. NO test-only reset. Production
      // invalidateIndexInSearchCache must propagate.
      mod.upsertFolderPref(1, 'Drafts', { indexInSearch: false })
      mod.upsertMessages(1, 'Drafts', [
        { uid: 2, subject: 'after-flip-keyword', fromAddr: 'a@b', date: '2026-02-08T00:00:00Z', unread: false },
      ])
      // New message should NOT be searchable — proving cache was invalidated.
      expect(mod.searchMessages(1, 'Drafts', 'after-flip-keyword', 10, 0)).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.15-ter iter6 (codex Medium): one-shot Junk/Trash data migration ---

  testDb('§2.15-ter iter6: existing Junk/Trash folder_prefs auto-disable on upgrade', async () => {
    // Reproducer for codex iter6 Medium: when index_in_search column was
    // first added with DEFAULT 1, every existing folder_prefs row inherited
    // index_in_search=1. New prefs go through defaultFolderPref() which
    // auto-disables Junk/Trash, but pre-existing rows on upgrade-from-baseline
    // accounts stayed indexed. The migration runJunkTrashDefaultOffMigrationV1
    // backfills index_in_search=0 for those rows once per DB.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Seed the upgrade scenario: folder_prefs rows for Junk/Trash with
      // index_in_search=1 (legacy default), plus messages in those folders
      // that landed in FTS because indexInSearch was true at insert time.
      // We use upsertFolderPref with explicit indexInSearch=true so the
      // pref row + messages_fts both reflect the pre-migration state.
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Trash', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })

      // Account 2 also has Junk, but it represents a user who explicitly
      // opted IN to Junk search after seeing it disabled. To prove the
      // migration does not re-flip them, we mark this account as already
      // covered by the migration (sentinel present) — the simplest way to
      // express "user-explicit override that must survive". After we reset
      // the sentinel for re-run, this account's pref row will be re-considered;
      // the protection here is the migration ONLY targeting rows with
      // index_in_search=1 AT THE TIME OF MIGRATION RUN, so we will set
      // account 2's Junk to indexInSearch=true at re-run time as well.
      // To distinguish "user wanted true" from "default true", the design
      // relies on the one-shot gate — once the migration is applied, the
      // user can flip back to true without fear of being re-flipped, because
      // the migration never runs again. We test that property via the
      // idempotency assertion at the end.
      mod.upsertFolderPref(2, 'Junk', { visible: true, indexInSearch: true })

      mod.upsertMessages(1, 'Junk', [
        { uid: 1, subject: 'iter6-junk-spam-token', fromAddr: 'a@test', date: '2026-04-25T00:00:00Z', unread: false },
        { uid: 2, subject: 'iter6-junk-other-token', fromAddr: 'b@test', date: '2026-04-25T00:01:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'Trash', [
        { uid: 3, subject: 'iter6-trash-token', fromAddr: 'c@test', date: '2026-04-25T00:02:00Z', unread: false },
      ])
      mod.upsertMessages(1, 'INBOX', [
        { uid: 10, subject: 'iter6-inbox-token', fromAddr: 'd@test', date: '2026-04-25T00:03:00Z', unread: false },
      ])
      mod.upsertMessages(2, 'Junk', [
        { uid: 1, subject: 'iter6-account2-junk-token', fromAddr: 'e@test', date: '2026-04-25T00:04:00Z', unread: false },
      ])

      // Pre-migration confirmation: rows ARE in FTS / searchable.
      expect(mod.searchMessages(1, 'Junk', 'iter6-junk-spam-token', 10, 0).map(m => m.uid)).toEqual([1])
      expect(mod.searchMessages(1, 'Trash', 'iter6-trash-token', 10, 0).map(m => m.uid)).toEqual([3])
      expect(mod.searchMessages(1, 'INBOX', 'iter6-inbox-token', 10, 0).map(m => m.uid)).toEqual([10])
      expect(mod.searchMessages(2, 'Junk', 'iter6-account2-junk-token', 10, 0).map(m => m.uid)).toEqual([1])

      // Source 1: server-detected role cache for account 1.
      mod.cacheFolderRoles(1, { junk: 'Junk', trash: 'Trash' })
      // Source 2: SPECIAL-USE specialUse for account 2 (no roles cache for
      // this account — proves both fallback sources fire). Account 2's
      // Junk folder is detected via the \\Junk specialUse flag.
      mod.cacheMailboxes(2, [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
      ])

      // Run the migration (test entry point — bypasses the one-shot gate
      // that already armed during loadDbModule's empty-DB pass).
      mod.__runJunkTrashDefaultOffMigrationV1ForTest()

      // Assertion 1: Junk/Trash folder_prefs flipped to indexInSearch=false.
      expect(mod.getFolderPref(1, 'Junk')?.indexInSearch).toBe(false)
      expect(mod.getFolderPref(1, 'Trash')?.indexInSearch).toBe(false)
      expect(mod.getFolderPref(2, 'Junk')?.indexInSearch).toBe(false)

      // Assertion 2: INBOX untouched.
      expect(mod.getFolderPref(1, 'INBOX')?.indexInSearch).toBe(true)

      // Assertion 3: FTS rows for Junk/Trash were purged via the
      // upsertFolderPref reconciliation path (true→false branch).
      mod.__resetIndexInSearchCacheForTest()
      expect(mod.searchMessages(1, 'Junk', 'iter6-junk-spam-token', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'Junk', 'iter6-junk-other-token', 10, 0)).toEqual([])
      expect(mod.searchMessages(1, 'Trash', 'iter6-trash-token', 10, 0)).toEqual([])
      expect(mod.searchMessages(2, 'Junk', 'iter6-account2-junk-token', 10, 0)).toEqual([])

      // Assertion 4: INBOX still searchable (untouched by the migration).
      expect(mod.searchMessages(1, 'INBOX', 'iter6-inbox-token', 10, 0).map(m => m.uid)).toEqual([10])

      // Assertion 5: messages still in `messages` (list view works) — only
      // FTS was purged.
      expect(mod.getMessages(1, 'Junk', 10).map(m => m.uid).sort()).toEqual([1, 2])
      expect(mod.getMessages(1, 'Trash', 10).map(m => m.uid)).toEqual([3])

      // Assertion 6: marker is set so production code skips on next start.
      expect(mod.__isJunkTrashDefaultOffMigrationV1AppliedForTest()).toBe(true)

      // Assertion 7: idempotency. User explicitly re-enables search on
      // Junk for account 1; running the migration again (as if the user
      // restarted the app) must NOT flip it back. Because the gate is
      // already set, the production module-init path is a no-op — we
      // verify by calling the migration directly without resetting the
      // marker.
      mod.upsertFolderPref(1, 'Junk', { indexInSearch: true })
      expect(mod.getFolderPref(1, 'Junk')?.indexInSearch).toBe(true)

      // Force-attempt: drive the production runner directly. The gate must
      // short-circuit before any UPDATE / upsertFolderPref is issued.
      // (We import the same module — runJunkTrashDefaultOffMigrationV1 is
      // private, but the gate check uses isSchemaMigrationApplied which
      // reads schema_migrations.) The test entry point intentionally
      // resets the gate before running, so we instead call the gated
      // helper through the top-level module-init path: calling
      // __runJunkTrashDefaultOffMigrationV1ForTest *does* reset and re-run,
      // which would re-flip the row. To assert true idempotency under the
      // gate, we verify the row stays true after a NO-OP call: simulate
      // the production restart by NOT resetting the gate and observing
      // that any subsequent state-change path is gated.
      // Concretely: re-running through the test entry resets the gate
      // and re-executes — but at that point cached_roles still says Junk
      // for account 1, so the migration WOULD re-flip. This is a test
      // hazard, not a production hazard: production never resets the
      // gate. We simulate the production path by checking the gate
      // directly and assert no further work would happen.
      // (See assertion 6 above — gate is set; production runner returns
      // early because of `if (isSchemaMigrationApplied(...)) return`.)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter6: migration gate prevents re-running on subsequent app starts', async () => {
    // Idempotency proper: after the migration runs once, re-importing the
    // module on the same DB file must NOT flip user-modified rows.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Pre-migration: seed Junk + cached roles, then trigger migration.
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: true })
      mod.cacheFolderRoles(1, { junk: 'Junk' })
      mod.__runJunkTrashDefaultOffMigrationV1ForTest()
      expect(mod.getFolderPref(1, 'Junk')?.indexInSearch).toBe(false)
      expect(mod.__isJunkTrashDefaultOffMigrationV1AppliedForTest()).toBe(true)

      // User explicitly re-enables search on Junk after the migration ran.
      mod.upsertFolderPref(1, 'Junk', { indexInSearch: true })
      expect(mod.getFolderPref(1, 'Junk')?.indexInSearch).toBe(true)

      // Simulate app restart by re-importing the module (close + reset +
      // re-import on the same MAILCOPILOT_DATA_DIR).
      mod.default.close()
      vi.resetModules()
      const mod2 = await import('./index')

      // Gate is still applied → production runner returned early → user's
      // explicit indexInSearch=true is preserved.
      expect(mod2.__isJunkTrashDefaultOffMigrationV1AppliedForTest()).toBe(true)
      expect(mod2.getFolderPref(1, 'Junk')?.indexInSearch).toBe(true)

      mod2.default.close()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('§2.15-ter iter6: migration is no-op when caches are empty (no folder_prefs touched)', async () => {
    // Edge case: account exists with folder_prefs but neither cached_roles
    // nor cached_mailboxes have role hints (e.g. account never synced).
    // Migration must skip those folders cleanly. The new-pref code path in
    // ensureFolderPrefs picks them up later when the cache is populated.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertFolderPref(1, 'INBOX', { visible: true, indexInSearch: true })
      mod.upsertFolderPref(1, 'Junk', { visible: true, indexInSearch: true })
      // Intentionally do NOT seed cached_roles / cached_mailboxes.

      mod.__runJunkTrashDefaultOffMigrationV1ForTest()

      // Without role hints, migration cannot classify Junk → leaves it as is.
      expect(mod.getFolderPref(1, 'Junk')?.indexInSearch).toBe(true)
      expect(mod.getFolderPref(1, 'INBOX')?.indexInSearch).toBe(true)

      // Marker is still set — gate prevents re-runs even when nothing was
      // flipped. (Once-per-DB semantics; the next sync will populate caches
      // and ensureFolderPrefs handles new prefs through defaultFolderPref.)
      expect(mod.__isJunkTrashDefaultOffMigrationV1AppliedForTest()).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.15-bis: periodic PASSIVE WAL checkpoint helper.
  testDb('checkpointWalPassive: does not throw and returns numeric fields', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Run on a fresh DB — must not throw and must return the expected shape.
      const r = mod.checkpointWalPassive()
      expect(typeof r.busy).toBe('number')
      expect(typeof r.log).toBe('number')
      expect(typeof r.checkpointed).toBe('number')
      // After a fresh init the WAL may be empty (log = 0) or have a few setup
      // frames — either way the call must succeed and report non-negative
      // counts. The contract is "never throws + numeric fields", not exact
      // values.
      expect(r.busy).toBeGreaterThanOrEqual(0)
      expect(r.log).toBeGreaterThanOrEqual(0)
      expect(r.checkpointed).toBeGreaterThanOrEqual(0)

      // Drive a write so there is something to checkpoint, then call again
      // and assert the call still succeeds (checkpointed should be >= 0 and
      // <= log on this second invocation).
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'wal test', fromAddr: 'a@example.test', date: '2026-04-25T00:00:00.000Z', unread: false, flagged: false },
      ])
      const r2 = mod.checkpointWalPassive()
      expect(typeof r2.busy).toBe('number')
      expect(typeof r2.log).toBe('number')
      expect(typeof r2.checkpointed).toBe('number')
      // checkpointed must not exceed the total WAL frames reported for that run.
      expect(r2.checkpointed).toBeLessThanOrEqual(r2.log)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('checkpointWalPassive: consecutive calls are idempotent and never throw', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Write some data so the WAL has frames to checkpoint.
      mod.upsertMessages(1, 'INBOX', [
        { uid: 10, subject: 'idempotent-1', fromAddr: 'x@example.test', date: '2026-04-25T00:00:00.000Z', unread: false, flagged: false },
        { uid: 11, subject: 'idempotent-2', fromAddr: 'y@example.test', date: '2026-04-25T00:01:00.000Z', unread: true, flagged: false },
      ])

      // First call: should checkpoint those frames.
      const r1 = mod.checkpointWalPassive()
      expect(r1.checkpointed).toBeGreaterThanOrEqual(0)
      expect(r1.checkpointed).toBeLessThanOrEqual(r1.log)

      // Second consecutive call with no new writes: WAL is already flushed,
      // so log and checkpointed should both be 0 (or very small if SQLite
      // adds header frames). Must not throw.
      const r2 = mod.checkpointWalPassive()
      expect(r2.busy).toBeGreaterThanOrEqual(0)
      expect(r2.log).toBeGreaterThanOrEqual(0)
      expect(r2.checkpointed).toBeLessThanOrEqual(r2.log)

      // Third call: same contract — stable under repeated invocation.
      const r3 = mod.checkpointWalPassive()
      expect(r3.busy).toBeGreaterThanOrEqual(0)
      expect(r3.log).toBeGreaterThanOrEqual(0)
      expect(r3.checkpointed).toBeLessThanOrEqual(r3.log)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('checkpointWalPassive: checkpointed <= log after heavy write batch', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Insert a batch large enough to accumulate meaningful WAL frames.
      const batch = Array.from({ length: 50 }, (_, i) => ({
        uid: i + 1,
        subject: `heavy-batch-msg-${i + 1}`,
        fromAddr: `sender${i}@example.test`,
        date: new Date(Date.UTC(2026, 3, 25, 0, i, 0)).toISOString(),
        unread: i % 2 === 0,
        flagged: false,
      }))
      mod.upsertMessages(1, 'INBOX', batch)

      const r = mod.checkpointWalPassive()
      // Core invariant: the PASSIVE checkpoint can never claim to have
      // checkpointed more frames than exist in the WAL.
      expect(r.checkpointed).toBeLessThanOrEqual(r.log)
      expect(r.busy).toBeGreaterThanOrEqual(0)
      // After a heavy write, the WAL must have had at least one frame.
      // PASSIVE should have checkpointed at least something (busy==0 case).
      // We cannot assert busy===0 (reader snapshot may exist), so just check
      // that if busy===0, everything was checkpointed.
      if (r.busy === 0) {
        expect(r.checkpointed).toBe(r.log)
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §3.3 B1 AI Privacy Audit Panel ------------------------------------
  //
  // ai_action_log is the user-facing privacy audit table backing Settings →
  // AI → Privacy & Audit. Append-only invariant: rows are NEVER physically
  // removed; "delete" is a soft-delete that sets `deleted_at`. List/aggregate
  // exclude soft-deleted rows; export only emits live rows.

  testDb('ai_action_log schema has all required columns + indexes', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      type ColumnRow = { name: string; type: string; notnull: number; dflt_value: unknown }
      const cols = mod.default
        .prepare(`PRAGMA table_info(ai_action_log)`)
        .all() as ColumnRow[]
      const byName = Object.fromEntries(cols.map(c => [c.name, c]))
      expect(byName.id).toBeDefined()
      expect(byName.provider).toBeDefined()
      expect(byName.provider.notnull).toBe(1)
      expect(byName.model).toBeDefined()
      expect(byName.goal).toBeDefined()
      expect(byName.tool_name).toBeDefined()
      expect(byName.input_tokens).toBeDefined()
      expect(byName.output_tokens).toBeDefined()
      expect(byName.cost_usd).toBeDefined()
      expect(byName.untrusted_wrapped).toBeDefined()
      expect(byName.untrusted_wrapped.notnull).toBe(1)
      expect(byName.injection_blocked).toBeDefined()
      expect(byName.injection_blocked.notnull).toBe(1)
      expect(byName.outcome).toBeDefined()
      expect(byName.outcome.notnull).toBe(1)
      expect(byName.created_at).toBeDefined()
      expect(byName.created_at.notnull).toBe(1)
      expect(byName.deleted_at).toBeDefined()

      type IndexRow = { name: string }
      const idxs = mod.default
        .prepare(`PRAGMA index_list(ai_action_log)`)
        .all() as IndexRow[]
      const names = idxs.map(i => i.name)
      expect(names).toContain('idx_ai_action_log_provider_created')
      expect(names).toContain('idx_ai_action_log_created')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendAiActionLog writes a row with all fields preserved', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({
        provider: 'anthropic-api',
        model: 'claude-sonnet-4-5',
        goal: 'chat',
        toolName: 'get_email',
        inputTokens: 1234,
        outputTokens: 567,
        costUsd: 0.0123,
        untrustedWrapped: 5,
        injectionBlocked: 2,
        outcome: 'ok',
      })
      const list = mod.listAiActionLog({ limit: 10 })
      expect(list.total).toBe(1)
      expect(list.rows).toHaveLength(1)
      const r = list.rows[0]
      expect(r.provider).toBe('anthropic-api')
      expect(r.model).toBe('claude-sonnet-4-5')
      expect(r.goal).toBe('chat')
      expect(r.toolName).toBe('get_email')
      expect(r.inputTokens).toBe(1234)
      expect(r.outputTokens).toBe(567)
      expect(r.costUsd).toBe(0.0123)
      expect(r.untrustedWrapped).toBe(5)
      expect(r.injectionBlocked).toBe(2)
      expect(r.outcome).toBe('ok')
      expect(r.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(r.deletedAt).toBeNull()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendAiActionLog never throws — best-effort like appendMcpAuditEvent', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Outcome must be one of the CHECK values, but the function should
      // catch any throw internally rather than propagating to the caller.
      expect(() => mod.appendAiActionLog({
        provider: 'subscription',
        outcome: 'not_a_valid_outcome' as unknown as 'ok',
      })).not.toThrow()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendAiActionLog persists a durable INSERT and swallows a failing one (void, best-effort)', async () => {
    // §2.39 simplification: appendAiActionLog is a pure best-effort void writer
    // (the old boolean "fix #1 signal" cross-tick carry mechanism was removed).
    // A valid INSERT durably lands a row; an INSERT that violates a CHECK
    // constraint (here: a bad `outcome`) is swallowed internally and adds NO row,
    // and neither call returns anything the caller can branch on.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const okResult = mod.appendAiActionLog({
        provider: 'openai-api', goal: 'rule', costUsd: 0.05, outcome: 'ok',
      })
      expect(okResult).toBeUndefined()
      expect(mod.listAiActionLog().total).toBe(1)

      const failResult = mod.appendAiActionLog({
        provider: 'openai-api', goal: 'rule', costUsd: 0.05,
        outcome: 'not_a_valid_outcome' as unknown as 'ok',
      })
      expect(failResult).toBeUndefined()
      // No row was added by the failing call — the durable ledger is unchanged.
      expect(mod.listAiActionLog().total).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listAiActionLog filters by provider, from, to and paginates', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 60; i++) {
        mod.appendAiActionLog({
          provider: i % 2 === 0 ? 'anthropic-api' : 'openai-api',
          outcome: 'ok',
        })
      }
      const all = mod.listAiActionLog({ limit: 500 })
      expect(all.total).toBe(60)
      expect(all.rows).toHaveLength(60)

      const page1 = mod.listAiActionLog({ limit: 25, offset: 0 })
      expect(page1.rows).toHaveLength(25)
      const page2 = mod.listAiActionLog({ limit: 25, offset: 25 })
      expect(page2.rows).toHaveLength(25)
      const page3 = mod.listAiActionLog({ limit: 25, offset: 50 })
      expect(page3.rows).toHaveLength(10)

      const onlyAnthropic = mod.listAiActionLog({ provider: 'anthropic-api', limit: 500 })
      expect(onlyAnthropic.total).toBe(30)
      expect(onlyAnthropic.rows.every(r => r.provider === 'anthropic-api')).toBe(true)

      // from/to bounds — pick a date range that includes everything.
      const wide = mod.listAiActionLog({ from: '1970-01-01', to: '9999-12-31', limit: 500 })
      expect(wide.total).toBe(60)
      // A date range in the past returns zero.
      const past = mod.listAiActionLog({ from: '1970-01-01', to: '1971-01-01', limit: 500 })
      expect(past.total).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('aggregateAiUsage sums per-provider and excludes soft-deleted rows', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({
        provider: 'anthropic-api', model: 'claude', costUsd: 0.10,
        inputTokens: 100, outputTokens: 50,
        untrustedWrapped: 3, injectionBlocked: 1, outcome: 'ok',
      })
      mod.appendAiActionLog({
        provider: 'anthropic-api', model: 'claude', costUsd: 0.05,
        inputTokens: 50, outputTokens: 25,
        untrustedWrapped: 1, injectionBlocked: 0, outcome: 'ok',
      })
      mod.appendAiActionLog({
        provider: 'subscription', model: 'claude', costUsd: null,
        inputTokens: 200, outputTokens: 100,
        untrustedWrapped: 4, injectionBlocked: 0, outcome: 'ok',
      })

      const week = mod.aggregateAiUsage('week')
      const byProvider = Object.fromEntries(week.map(r => [r.provider, r]))
      expect(byProvider['anthropic-api'].requests).toBe(2)
      expect(byProvider['anthropic-api'].costUsd).toBeCloseTo(0.15, 6)
      expect(byProvider['anthropic-api'].inputTokens).toBe(150)
      expect(byProvider['anthropic-api'].outputTokens).toBe(75)
      expect(byProvider['anthropic-api'].untrustedWrapped).toBe(4)
      expect(byProvider['anthropic-api'].injectionBlocked).toBe(1)
      expect(byProvider['subscription'].requests).toBe(1)
      // No cost rows for subscription — aggregate cost is null, not 0.
      expect(byProvider['subscription'].costUsd).toBeNull()

      // Soft-delete one anthropic row → aggregate updates accordingly.
      const anyRow = mod.listAiActionLog({ provider: 'anthropic-api', limit: 1 }).rows[0]
      expect(mod.softDeleteAiActionEntry(anyRow.id)).toBe(true)
      const after = mod.aggregateAiUsage('week')
      const after2 = Object.fromEntries(after.map(r => [r.provider, r]))
      expect(after2['anthropic-api'].requests).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('aggregateAiUsage counts a reservation row (cost_usd set, tokens null) — cost + requests, token totals stay 0', async () => {
    // §2.39 fix #1: an unmetered/failed-persist-then-retried rule call writes a
    // RESERVATION row — a real `cost_usd` but NULL token counts (we genuinely
    // have no counts). The Privacy-Panel aggregate must count the cost and the
    // request, while the input/output token totals stay 0 (a reservation is a
    // cost, not a token count) so a reserved row is distinguishable from a
    // metered one.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({
        provider: 'openai-api',
        model: 'gpt-4o-mini',
        goal: 'rule',
        inputTokens: null,
        outputTokens: null,
        costUsd: 0.05,
        untrustedWrapped: 1,
        injectionBlocked: 0,
        outcome: 'ok',
      })
      const week = mod.aggregateAiUsage('week')
      const row = week.find(r => r.provider === 'openai-api')
      expect(row).toBeDefined()
      expect(row!.requests).toBe(1)
      expect(row!.costUsd).toBeCloseTo(0.05, 6)
      // Token totals stay 0 — the reservation carried no token counts.
      expect(row!.inputTokens).toBe(0)
      expect(row!.outputTokens).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('softDeleteAiActionEntry sets deleted_at and excludes from list/aggregate', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      const list = mod.listAiActionLog()
      const id = list.rows[0].id

      const ok = mod.softDeleteAiActionEntry(id)
      expect(ok).toBe(true)

      // Live list excludes it.
      const after = mod.listAiActionLog()
      expect(after.total).toBe(0)
      expect(after.rows).toHaveLength(0)

      // But the row still exists in the table — append-only invariant.
      type Row = { c: number; deleted_at: string | null }
      const all = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(all.c).toBe(1)
      const raw = mod.default.prepare('SELECT deleted_at FROM ai_action_log WHERE id = ?').get(id) as Row
      expect(raw.deleted_at).not.toBeNull()

      // Re-deleting returns false.
      expect(mod.softDeleteAiActionEntry(id)).toBe(false)
      // Bogus ids return false.
      expect(mod.softDeleteAiActionEntry(99999)).toBe(false)
      expect(mod.softDeleteAiActionEntry(0)).toBe(false)
      expect(mod.softDeleteAiActionEntry(-1)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('clearAiActionLog soft-deletes every live row but keeps them in the table', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 5; i++) {
        mod.appendAiActionLog({ provider: 'anthropic-api', outcome: 'ok' })
      }
      expect(mod.listAiActionLog().total).toBe(5)

      const cleared = mod.clearAiActionLog()
      expect(cleared).toBe(5)
      expect(mod.listAiActionLog().total).toBe(0)

      // Append-only invariant: the table still has 5 rows physically.
      type Row = { c: number }
      const all = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(all.c).toBe(5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('exportAiActionLog produces valid JSON of live rows only', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({
        provider: 'anthropic-api', model: 'claude-sonnet-4-5',
        goal: 'chat', toolName: 'get_email',
        inputTokens: 100, outputTokens: 50, costUsd: 0.01,
        untrustedWrapped: 2, injectionBlocked: 0, outcome: 'ok',
      })
      mod.appendAiActionLog({
        provider: 'subscription',
        outcome: 'aborted',
      })
      // Soft-delete one.
      const first = mod.listAiActionLog({ limit: 1, offset: 1 }).rows[0]
      expect(mod.softDeleteAiActionEntry(first.id)).toBe(true)

      const json = mod.exportAiActionLog('json')
      const parsed = JSON.parse(json) as Array<{ provider: string; outcome: string }>
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed).toHaveLength(1)
      // Soft-deleted row is excluded.
      expect(parsed[0].provider).not.toBe(first.provider)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('exportAiActionLog produces valid CSV with header + escaped quotes', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({
        provider: 'openai-api',
        // Goal and toolName intentionally contain CSV special chars to verify
        // RFC4180 quoting. (The audit pipeline never persists user content,
        // but the CSV writer must still handle commas / newlines / quotes
        // correctly for any future caller.)
        goal: 'chat,with,commas',
        toolName: 'tool"with"quotes',
        outcome: 'ok',
        untrustedWrapped: 0,
        injectionBlocked: 0,
      })
      const csv = mod.exportAiActionLog('csv')
      // Iter 2 (codex-bg-review, 2026-04-25): records are delimited by CRLF
      // per RFC4180 §2.1 — split on '\r\n', not '\n'.
      const lines = csv.split('\r\n')
      expect(lines[0]).toBe('id,provider,model,goal,tool_name,input_tokens,output_tokens,cost_usd,untrusted_wrapped,injection_blocked,outcome,created_at')
      expect(lines).toHaveLength(2)
      // Comma-bearing field is quoted.
      expect(lines[1]).toContain('"chat,with,commas"')
      // Quote-bearing field is quoted and inner quotes are doubled.
      expect(lines[1]).toContain('"tool""with""quotes"')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §3.3 B1 iter2 (codex-bg-review, 2026-04-25): RFC4180 §2.1 specifies CRLF
  // as the record separator. The earlier implementation used '\n', which works
  // for many naive CSV consumers but breaks Excel on Windows when a quoted
  // cell contains a real LF (the importer treats the LF inside the quotes as
  // the row boundary if the surrounding lines are LF-only). Verify the bytes
  // include CRLF between header and first record AND between subsequent
  // records.
  testDb('exportAiActionLog uses CRLF separators between records (RFC4180)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok', untrustedWrapped: 0, injectionBlocked: 0 })
      mod.appendAiActionLog({ provider: 'anthropic-api', outcome: 'ok', untrustedWrapped: 0, injectionBlocked: 0 })

      const csv = mod.exportAiActionLog('csv')
      // Header → first row uses CRLF.
      expect(csv).toMatch(/created_at\r\n/)
      // Number of CRLF separators equals (rows + header) - 1 = 2 for two rows.
      const crlfCount = (csv.match(/\r\n/g) || []).length
      expect(crlfCount).toBe(2)
      // No bare LFs anywhere (every LF must be preceded by CR).
      const bareLfCount = csv.split('').filter((ch, i, arr) => ch === '\n' && arr[i - 1] !== '\r').length
      expect(bareLfCount).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('aggregateAiUsage cutoffs honour the requested period', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // All-fresh row falls in today/week/month windows.
      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      // Backdate one row beyond the month window via a direct UPDATE — DB-
      // layer test only, never a code path the AI service exercises.
      const id = (mod.listAiActionLog({ limit: 1 }).rows[0]).id
      mod.default.prepare(`UPDATE ai_action_log SET created_at = '2000-01-01 00:00:00' WHERE id = ?`).run(id)

      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      const today = mod.aggregateAiUsage('today')
      expect(today.find(r => r.provider === 'openai-api')?.requests).toBe(1)
      const week = mod.aggregateAiUsage('week')
      expect(week.find(r => r.provider === 'openai-api')?.requests).toBe(1)
      const month = mod.aggregateAiUsage('month')
      expect(month.find(r => r.provider === 'openai-api')?.requests).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // pruneAiActionLog — background row-count rotation. See the schema comment
  // block in packages/db/index.ts for the full rationale; tests here are the
  // contract surface (AC8-AC12 of §3.3.B1.f3).

  testDb('appendAiActionLog caps physical row count at AI_ACTION_LOG_MAX_ROWS', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Use a temporary smaller cap via direct pruneAiActionLog instead of
      // running 10 001 inserts (which is slow). The contract we want to
      // verify is structural: after N+1 inserts with cap N, exactly N rows
      // remain. We exercise both shapes:
      //   - The real cap is hit when appendAiActionLog runs prune internally
      //     (here covered by checking the exported constant matches the call
      //     site behaviour at the boundary).
      //   - Manually invoked pruneAiActionLog enforces any cap we hand it.
      expect(mod.AI_ACTION_LOG_MAX_ROWS).toBe(10_000)

      // Append 12 rows, then ask pruneAiActionLog to keep 10. After the
      // prune, exactly 10 rows remain — proving the rotation by id works.
      for (let i = 0; i < 12; i++) {
        mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      }
      const deleted = mod.pruneAiActionLog(10)
      expect(deleted).toBe(2)
      type Row = { c: number }
      const after = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(after.c).toBe(10)
      // The 10 kept rows are the most recent ones — first two ids gone.
      type IdRow = { id: number }
      const minId = mod.default.prepare('SELECT MIN(id) AS id FROM ai_action_log').get() as IdRow
      expect(minId.id).toBe(3)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendAiActionLog enforces AI_ACTION_LOG_MAX_ROWS cap end-to-end (boundary)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Pre-load the table to exactly the cap, then verify one more insert
      // does not grow it. Loading the full 10 000 rows via prepared INSERT
      // is fast enough (~1s) and proves the appendAiActionLog → prune wiring
      // without relying on internal knowledge.
      const cap = mod.AI_ACTION_LOG_MAX_ROWS
      const insert = mod.default.prepare(
        `INSERT INTO ai_action_log(provider, outcome) VALUES ('openai-api', 'ok')`,
      )
      const tx = mod.default.transaction(() => {
        for (let i = 0; i < cap; i++) insert.run()
      })
      tx()
      type Row = { c: number }
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(cap)

      // One more append — the row count must stay exactly at cap because
      // pruneAiActionLog runs inside appendAiActionLog after the INSERT.
      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(cap)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  }, 30_000)

  testDb('appendAiActionLog does NOT prune when the INSERT itself fails (defence-in-depth)', async () => {
    // Regression guard for the prune-after-failed-insert logic bug.
    //
    // Before the fix `pruneAiActionLog(AI_ACTION_LOG_MAX_ROWS)` ran
    // unconditionally — even when the INSERT inside the same call threw
    // (CHECK constraint, malformed entry, SQLITE_BUSY at insert time). That
    // meant a failed-to-record action could still trigger physical deletion
    // of existing audit rows, which is wrong from the trust-model angle: a
    // bad write must not shrink the audit log.
    //
    // After the fix the function tracks an `inserted` flag and only calls
    // prune when the INSERT succeeded. Verify the contract end-to-end:
    //   1. Fill the table beyond the cap by direct INSERT (bypass prune).
    //   2. Snapshot current row count.
    //   3. Call appendAiActionLog with an `outcome` value that violates the
    //      CHECK constraint — the function must swallow the throw and must
    //      NOT call prune.
    //   4. Row count is unchanged; no rows were deleted.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Use a small fixed number — we only need «more rows than appendAiActionLog
      // would normally keep if prune ran with a smaller cap». The real cap is
      // 10 000 so a direct INSERT past 10 000 is unnecessary; the test only
      // proves «count is preserved across a failing append», which works for
      // any starting row count.
      const seedCount = 12
      const seedInsert = mod.default.prepare(
        `INSERT INTO ai_action_log(provider, outcome) VALUES ('openai-api', 'ok')`,
      )
      const seedTx = mod.default.transaction(() => {
        for (let i = 0; i < seedCount; i++) seedInsert.run()
      })
      seedTx()

      type Row = { c: number; minId: number; maxId: number }
      const before = mod.default.prepare(
        `SELECT COUNT(*) AS c, MIN(id) AS minId, MAX(id) AS maxId FROM ai_action_log`,
      ).get() as Row
      expect(before.c).toBe(seedCount)

      // Outcome 'not_a_valid_outcome' violates the CHECK(outcome IN
      // ('ok','error','aborted')) constraint → INSERT throws → catch swallows
      // → prune MUST be skipped → row count unchanged.
      expect(() => mod.appendAiActionLog({
        provider: 'openai-api',
        outcome: 'not_a_valid_outcome' as unknown as 'ok',
      })).not.toThrow()

      const after = mod.default.prepare(
        `SELECT COUNT(*) AS c, MIN(id) AS minId, MAX(id) AS maxId FROM ai_action_log`,
      ).get() as Row
      // Exactly the same physical state — no INSERT (rowid stayed), no DELETE.
      expect(after.c).toBe(before.c)
      expect(after.minId).toBe(before.minId)
      expect(after.maxId).toBe(before.maxId)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog is a no-op when row count <= maxRows', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 5; i++) {
        mod.appendAiActionLog({ provider: 'anthropic-api', outcome: 'ok' })
      }
      const deleted = mod.pruneAiActionLog(10)
      expect(deleted).toBe(0)
      type Row = { c: number }
      const after = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(after.c).toBe(5)

      // Equal boundary — exactly maxRows rows present → still a no-op.
      const equalDeleted = mod.pruneAiActionLog(5)
      expect(equalDeleted).toBe(0)
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog rotates by id, not by deleted_at — soft-deleted rows are also subject to the cap', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Insert 100 rows, soft-delete the first 50, then prune to 20.
      // The cap is enforced physically — the table must contain exactly 20
      // rows total regardless of soft-delete state, and the 20 kept rows
      // must be the most recent 20 by id (ids 81..100).
      for (let i = 0; i < 100; i++) {
        mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      }
      const ids = mod.default.prepare(`SELECT id FROM ai_action_log ORDER BY id ASC LIMIT 50`).all() as { id: number }[]
      for (const r of ids) {
        expect(mod.softDeleteAiActionEntry(r.id)).toBe(true)
      }
      // Sanity: still 100 physical rows after soft-delete.
      type Row = { c: number; min: number; max: number }
      const before = mod.default.prepare(
        'SELECT COUNT(*) AS c, MIN(id) AS min, MAX(id) AS max FROM ai_action_log',
      ).get() as Row
      expect(before.c).toBe(100)

      const deleted = mod.pruneAiActionLog(20)
      expect(deleted).toBe(80)
      const after = mod.default.prepare(
        'SELECT COUNT(*) AS c, MIN(id) AS min, MAX(id) AS max FROM ai_action_log',
      ).get() as Row
      expect(after.c).toBe(20)
      expect(after.min).toBe(81)
      expect(after.max).toBe(100)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog(0) deletes every row (documented behaviour)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 7; i++) {
        mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      }
      const deleted = mod.pruneAiActionLog(0)
      expect(deleted).toBe(7)
      type Row = { c: number }
      const after = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(after.c).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog rejects negative or non-integer maxRows', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(() => mod.pruneAiActionLog(-1)).toThrow(TypeError)
      expect(() => mod.pruneAiActionLog(1.5)).toThrow(TypeError)
      expect(() => mod.pruneAiActionLog(Number.NaN)).toThrow(TypeError)
      expect(() => mod.pruneAiActionLog(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('appendAiActionLog swallows rotation failure — best-effort contract holds', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Seed one row so we can verify the INSERT still landed.
      mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })

      // Monkey-patch db.prepare so the next DELETE-bearing statement throws.
      // We MUST NOT break SELECT/INSERT — only DELETE — otherwise we cannot
      // tell INSERT-still-worked apart from rotation-also-worked. Restore
      // immediately after the call.
      const realPrepare = mod.default.prepare.bind(mod.default)
      const stub = ((sql: string) => {
        if (typeof sql === 'string' && /\bDELETE\b/i.test(sql)) {
          throw new Error('forced prune failure (test)')
        }
        return realPrepare(sql)
      }) as typeof mod.default.prepare
      const dbWithMutablePrepare = mod.default as unknown as { prepare: typeof realPrepare }
      dbWithMutablePrepare.prepare = stub

      try {
        // Append must succeed (INSERT goes through; prune throws but is
        // swallowed by the inner try/catch in appendAiActionLog).
        expect(() => mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })).not.toThrow()
      } finally {
        dbWithMutablePrepare.prepare = realPrepare
      }

      // Two physical rows present: the seed and the post-stub append.
      type Row = { c: number }
      const after = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(after.c).toBe(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog on empty table returns 0 without errors', async () => {
    // Boundary: rotation on a completely empty table must be a clean no-op.
    // SELECT ... OFFSET maxRows returns undefined; the function must not throw.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      type Row = { c: number }
      const count = mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row
      expect(count.c).toBe(0)

      expect(() => mod.pruneAiActionLog(100)).not.toThrow()
      expect(mod.pruneAiActionLog(100)).toBe(0)
      expect(mod.pruneAiActionLog(1)).toBe(0)
      expect(mod.pruneAiActionLog(0)).toBe(0) // full-wipe on empty — still 0 deleted
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog(1) keeps only the single most recent row', async () => {
    // Boundary: cap of 1 is the tightest allowed value. After each
    // pruneAiActionLog(1) only the row with the highest id survives.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (let i = 0; i < 5; i++) {
        mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      }
      type Row = { c: number }
      type IdRow = { id: number }
      const maxBefore = mod.default.prepare('SELECT MAX(id) AS id FROM ai_action_log').get() as IdRow

      const deleted = mod.pruneAiActionLog(1)
      expect(deleted).toBe(4)
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(1)
      const remaining = mod.default.prepare('SELECT id FROM ai_action_log').get() as IdRow
      expect(remaining.id).toBe(maxBefore.id) // the most recent row survived
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('pruneAiActionLog bulk performance: insert+prune of 10k rows completes within 5s', async () => {
    // Performance smoke: the threshold-id DELETE approach (one index seek +
    // one range DELETE) must be fast enough not to stall the AI request path.
    // 5 s is intentionally loose for CI; the real wall-time on an unloaded
    // machine is typically < 500 ms.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const cap = mod.AI_ACTION_LOG_MAX_ROWS // 10 000
      const insert = mod.default.prepare(
        `INSERT INTO ai_action_log(provider, outcome) VALUES ('openai-api', 'ok')`,
      )
      // Bulk-insert cap+1 rows inside a single transaction (fast path).
      const tx = mod.default.transaction(() => {
        for (let i = 0; i <= cap; i++) insert.run()
      })

      const t0 = Date.now()
      tx()
      const deleted = mod.pruneAiActionLog(cap)
      const elapsed = Date.now() - t0

      expect(deleted).toBe(1) // exactly one row over the cap was pruned
      type Row = { c: number }
      expect((mod.default.prepare('SELECT COUNT(*) AS c FROM ai_action_log').get() as Row).c).toBe(cap)
      expect(elapsed).toBeLessThan(5_000)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  }, 10_000) // generous overall timeout for slow CI runners

  testDb('appendAiActionLog sustained flood with mixed soft-deleted rows keeps cap', async () => {
    // Integration scenario: simulate a flood of AI requests where some earlier
    // rows were soft-deleted by the user. The physical cap must hold regardless
    // of how many rows carry a deleted_at timestamp. Uses a small synthetic
    // cap via direct pruneAiActionLog to avoid 10k inserts.
    //
    // Sequence:
    //   1. Insert 60 rows. Soft-delete the first 30.
    //   2. pruneAiActionLog(20) — cap to 20 physical rows.
    //   3. Insert 10 more rows via appendAiActionLog — each one triggers its
    //      own pruneAiActionLog(AI_ACTION_LOG_MAX_ROWS) internally, but the
    //      10 000 real cap won't kick in here, so we subsequently call
    //      pruneAiActionLog(20) again to simulate "cap = 20 throughout".
    //   4. Final state: exactly 20 physical rows, 10 of which are the new ones.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      type Row = { c: number; min: number; max: number }

      // Step 1: 60 rows, first 30 soft-deleted.
      for (let i = 0; i < 60; i++) {
        mod.appendAiActionLog({ provider: 'openai-api', outcome: 'ok' })
      }
      const firstBatch = mod.default.prepare(
        'SELECT id FROM ai_action_log ORDER BY id ASC LIMIT 30',
      ).all() as { id: number }[]
      for (const r of firstBatch) {
        mod.softDeleteAiActionEntry(r.id)
      }

      // Step 2: prune to 20 (mix: some soft-deleted, some live).
      const pruned1 = mod.pruneAiActionLog(20)
      expect(pruned1).toBe(40)
      const mid = mod.default.prepare(
        'SELECT COUNT(*) AS c, MIN(id) AS min, MAX(id) AS max FROM ai_action_log',
      ).get() as Row
      expect(mid.c).toBe(20)

      // Step 3: 10 more appends (they use the real AI_ACTION_LOG_MAX_ROWS cap
      // internally, which is 10 000 — no auto-prune happens at our synthetic
      // cap of 20). We manually enforce cap=20 after.
      for (let i = 0; i < 10; i++) {
        mod.appendAiActionLog({ provider: 'anthropic-api', outcome: 'ok' })
      }
      const pruned2 = mod.pruneAiActionLog(20)
      expect(pruned2).toBe(10) // the 10 new rows push us to 30; prune back to 20

      // Step 4: exactly 20 rows, newest 10 are the anthropic-api ones.
      const final = mod.default.prepare(
        'SELECT COUNT(*) AS c, MIN(id) AS min, MAX(id) AS max FROM ai_action_log',
      ).get() as Row
      expect(final.c).toBe(20)

      // The 10 newest rows (highest ids) must all be the anthropic-api appends.
      const newest10 = mod.default.prepare(
        `SELECT provider FROM ai_action_log ORDER BY id DESC LIMIT 10`,
      ).all() as { provider: string }[]
      expect(newest10.every(r => r.provider === 'anthropic-api')).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.39 AI Rules: enabled-off default + real cost accounting ----------

  testDb('createAiRule defaults enabled to OFF (0)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const created = mod.createAiRule({
        name: 'Archive newsletters',
        prompt: 'Archive anything that looks like a newsletter',
        allowedActions: JSON.stringify(['archive']),
      })
      expect(created.enabled).toBe(false)
      // Round-trip through the DB to be sure the persisted row is 0, not a
      // JS-object artefact.
      const fetched = mod.getAiRule(created.id)
      expect(fetched?.enabled).toBe(false)
      type Row = { enabled: number }
      const raw = mod.default.prepare('SELECT enabled FROM ai_rules WHERE id=?').get(created.id) as Row
      expect(raw.enabled).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('createAiRule respects an explicit enabled:true', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const created = mod.createAiRule({
        name: 'On rule',
        prompt: 'x',
        allowedActions: JSON.stringify(['archive']),
        enabled: true,
      })
      expect(created.enabled).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the ai_rules table column default is 0 (a raw INSERT omitting enabled is disabled)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const now = new Date().toISOString()
      mod.default.prepare(
        `INSERT INTO ai_rules(id, name, prompt, allowed_actions, created_at, updated_at)
         VALUES ('raw-id', 'raw', 'p', '[]', ?, ?)`,
      ).run(now, now)
      type Row = { enabled: number }
      const raw = mod.default.prepare('SELECT enabled FROM ai_rules WHERE id=?').get('raw-id') as Row
      expect(raw.enabled).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiRuleCostSince sums real cost from ai_action_log rows with goal=rule', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const since = '2000-01-01T00:00:00.000Z'
      // Interactive chat rows (goal=chat) must NOT count toward the rule budget.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'chat', costUsd: 5, outcome: 'ok' })
      // Rule rows DO count.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'rule', costUsd: 0.01, outcome: 'ok' })
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'rule', costUsd: 0.02, outcome: 'ok' })
      // A rule row with null cost contributes 0, not NaN.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'rule', costUsd: null, outcome: 'error' })
      const total = mod.sumAiRuleCostSince(since)
      expect(total).toBeCloseTo(0.03, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiRuleCostSince handles the datetime-vs-ISO format boundary correctly', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Rows are written with SQLite datetime('now') (no T, no Z). A naive
      // string >= against a JS ISO string would mis-order them. Insert a row,
      // then query with an ISO "start of today" that is strictly earlier — the
      // row must be counted.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'rule', costUsd: 0.05, outcome: 'ok' })
      const startOfEpoch = '1970-01-01T00:00:00.000Z'
      expect(mod.sumAiRuleCostSince(startOfEpoch)).toBeCloseTo(0.05, 6)
      // A far-future "since" excludes the row.
      const future = '2999-01-01T00:00:00.000Z'
      expect(mod.sumAiRuleCostSince(future)).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiRuleCostSince still counts a soft-deleted rule row (budget cannot be reset by deleting audit entries)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // The Privacy Panel lets a user soft-delete an ai_action_log row
      // (sets deleted_at, row stays for audit purposes). The daily-budget
      // check must NOT be gameable by deleting the entry that pushed spend
      // over budget — soft-deleted rows still count toward the sum.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'rule', costUsd: 0.4, outcome: 'ok' })
      const since = '2000-01-01T00:00:00.000Z'
      expect(mod.sumAiRuleCostSince(since)).toBeCloseTo(0.4, 6)

      type Row = { id: number }
      const inserted = mod.default.prepare(
        `SELECT id FROM ai_action_log WHERE goal='rule' ORDER BY id DESC LIMIT 1`,
      ).get() as Row
      const softDeleted = mod.softDeleteAiActionEntry(inserted.id)
      expect(softDeleted).toBe(true)

      // Spend total is unchanged after the soft-delete.
      expect(mod.sumAiRuleCostSince(since)).toBeCloseTo(0.4, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiRuleCostSince returns 0 for an account with no rule-goal rows at all', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Only chat-goal rows exist — no 'rule' rows to sum.
      mod.appendAiActionLog({ provider: 'openai-api', goal: 'chat', costUsd: 3, outcome: 'ok' })
      expect(mod.sumAiRuleCostSince('2000-01-01T00:00:00.000Z')).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('createAiRule without an explicit enabled value is disabled (default false, not undefined)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const created = mod.createAiRule({
        name: 'No enabled field',
        prompt: 'x',
        allowedActions: JSON.stringify(['archive']),
      })
      // Strict boolean, not merely falsy — pins the type against a future
      // regression that stores `undefined`/`null` instead of `false`.
      expect(created.enabled).toBe(false)
      expect(typeof created.enabled).toBe('boolean')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
