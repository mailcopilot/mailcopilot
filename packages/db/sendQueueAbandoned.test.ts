import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

// A send_queue row left in `sending` by a quit or a crash mid-send carries no
// outcome: the server may already have accepted the message. Such a row goes
// to `failed` and is never put back to `queued` by the queue itself; the
// Message-ID is minted once per row so a manual resend reuses it.

let betterSqlite3Usable = true
let Database: typeof import('better-sqlite3')
try {
  const mod = await import('better-sqlite3')
  Database = mod.default as unknown as typeof import('better-sqlite3')
  const probe = new (mod.default as unknown as new (p: string) => { close(): void })(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function withDb(seed: ((dir: string) => void) | null, fn: (mod: DbModule, dir: string) => void | Promise<void>) {
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-send-queue-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  let mod: DbModule | undefined
  try {
    seed?.(dir)
    mod = await import('./index')
    await fn(mod, dir)
  } finally {
    try { mod?.default.close() } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
    else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
  }
}

function backdate(mod: DbModule, id: string, msAgo: number) {
  mod.default.prepare(`UPDATE send_queue SET updated_at=? WHERE id=?`).run(new Date(Date.now() - msAgo).toISOString(), id)
}

const ABANDONED = '[mcerr:delivery_unknown] interrupted'

describe('packages/db — abandoned sends and the stored Message-ID', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('listDueSendQueue no longer puts a stale `sending` row back in the queue', async () => {
    await withDb(null, (mod) => {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, new Date(Date.now() - 60_000).toISOString(), 'q1', null, '<m1@test>')
      expect(mod.markSendQueueSending('q1')).toBe(true)
      backdate(mod, 'q1', 10 * 60_000)

      const due = mod.listDueSendQueue(new Date().toISOString(), 10)
      expect(due.map(r => r.id)).not.toContain('q1')
      expect(mod.getSendQueueById('q1')?.status).toBe('sending')
    })
  })

  testDb('failAbandonedSendQueue moves `sending` rows to failed with the given text, and they stay out of the queue', async () => {
    await withDb(null, (mod) => {
      const past = new Date(Date.now() - 60_000).toISOString()
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'abandoned' }, past, 'q-sending', null, '<m1@test>')
      mod.enqueueSendQueue(1, { to: 'b@test', subject: 'waiting' }, new Date(Date.now() + 60_000).toISOString(), 'q-queued', null, '<m2@test>')
      expect(mod.markSendQueueSending('q-sending')).toBe(true)

      const failed = mod.failAbandonedSendQueue(ABANDONED)
      expect(failed.map(r => r.id)).toEqual(['q-sending'])
      expect(failed[0].accountId).toBe(1)
      expect(failed[0].status).toBe('failed')
      expect((failed[0].messageData as { subject?: string }).subject).toBe('abandoned')

      const row = mod.getSendQueueById('q-sending')
      expect(row?.status).toBe('failed')
      expect(row?.lastError).toBe(ABANDONED)
      expect(mod.getSendQueueById('q-queued')?.status).toBe('queued')

      // No automatic resend: neither the next due listing nor a second recovery requeues it.
      expect(mod.listDueSendQueue(new Date().toISOString(), 10).map(r => r.id)).not.toContain('q-sending')
      expect(mod.failAbandonedSendQueue(ABANDONED)).toEqual([])
      expect(mod.getSendQueueById('q-sending')?.status).toBe('failed')
    })
  })

  testDb('failAbandonedSendQueue with a cutoff leaves a recently claimed row alone', async () => {
    await withDb(null, (mod) => {
      const past = new Date(Date.now() - 60_000).toISOString()
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'old' }, past, 'q-old', null, '<m1@test>')
      mod.enqueueSendQueue(1, { to: 'b@test', subject: 'recent' }, past, 'q-recent', null, '<m2@test>')
      mod.markSendQueueSending('q-old')
      mod.markSendQueueSending('q-recent')
      backdate(mod, 'q-old', 3 * 60_000)

      const cutoff = new Date(Date.now() - 2 * 60_000).toISOString()
      expect(mod.failAbandonedSendQueue(ABANDONED, cutoff).map(r => r.id)).toEqual(['q-old'])
      expect(mod.getSendQueueById('q-recent')?.status).toBe('sending')
    })
  })

  testDb('the Message-ID stored at enqueue survives a failure and a manual resend', async () => {
    await withDb(null, (mod) => {
      const past = new Date(Date.now() - 60_000).toISOString()
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, past, 'q1', null, '<fixed@test>')
      expect(mod.getSendQueueById('q1')?.messageId).toBe('<fixed@test>')

      mod.markSendQueueSending('q1')
      mod.failAbandonedSendQueue(ABANDONED)
      // Manual "send now" from the Outbox.
      expect(mod.sendQueueNow('q1')).toBe(true)
      const due = mod.listDueSendQueue(new Date().toISOString(), 10)
      expect(due.find(r => r.id === 'q1')?.messageId).toBe('<fixed@test>')
      // A candidate offered later does not replace the stored one.
      expect(mod.ensureSendQueueMessageId('q1', '<other@test>')).toBe('<fixed@test>')
      expect(mod.getSendQueueById('q1')?.messageId).toBe('<fixed@test>')
    })
  })

  testDb('a row without a Message-ID gets one on first use and keeps it', async () => {
    await withDb(null, (mod) => {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, new Date().toISOString(), 'q-legacy')
      expect(mod.getSendQueueById('q-legacy')?.messageId).toBeNull()
      expect(mod.ensureSendQueueMessageId('q-legacy', '<first@test>')).toBe('<first@test>')
      expect(mod.ensureSendQueueMessageId('q-legacy', '<second@test>')).toBe('<first@test>')
      expect(mod.ensureSendQueueMessageId('missing-row', '<x@test>')).toBeNull()
    })
  })

  testDb('migration adds message_id to a send_queue created before the column existed', async () => {
    const seed = (dir: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacy = new (Database as any)(path.join(dir, 'cache.db'))
      legacy.exec(`
        CREATE TABLE send_queue(
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL,
          message_data TEXT NOT NULL,
          send_at TEXT NOT NULL,
          status TEXT NOT NULL,
          last_error TEXT,
          attempt_count INTEGER DEFAULT 0,
          archive_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      const now = new Date().toISOString()
      legacy.prepare(`INSERT INTO send_queue(id, account_id, message_data, send_at, status, attempt_count, created_at, updated_at)
        VALUES('q-old', 1, '{"to":"a@test","subject":"old"}', ?, 'sending', 1, ?, ?)`).run(now, now, now)
      legacy.close()
    }
    await withDb(seed, (mod) => {
      const cols = mod.default.prepare(`PRAGMA table_info(send_queue)`).all() as Array<{ name: string }>
      expect(cols.map(c => c.name)).toContain('message_id')
      const old = mod.getSendQueueById('q-old')
      expect(old?.status).toBe('sending')
      expect(old?.messageId).toBeNull()
      expect(mod.failAbandonedSendQueue(ABANDONED).map(r => r.id)).toEqual(['q-old'])
    })
  })
})

describe('packages/db — abandoned sends: edges of the recovery query', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('the cutoff is strict: a row claimed exactly at the cutoff is left alone, one a millisecond older is failed', async () => {
    await withDb(null, (mod) => {
      const past = new Date(Date.now() - 60_000).toISOString()
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'at cutoff' }, past, 'q-at', null, '<m1@test>')
      mod.enqueueSendQueue(1, { to: 'b@test', subject: 'older' }, past, 'q-older', null, '<m2@test>')
      mod.markSendQueueSending('q-at')
      mod.markSendQueueSending('q-older')
      const cutoffMs = Date.now() - 5 * 60_000
      mod.default.prepare(`UPDATE send_queue SET updated_at=? WHERE id='q-at'`).run(new Date(cutoffMs).toISOString())
      mod.default.prepare(`UPDATE send_queue SET updated_at=? WHERE id='q-older'`).run(new Date(cutoffMs - 1).toISOString())

      expect(mod.failAbandonedSendQueue(ABANDONED, new Date(cutoffMs).toISOString()).map(r => r.id)).toEqual(['q-older'])
      expect(mod.getSendQueueById('q-at')?.status).toBe('sending')
    })
  })

  testDb('only `sending` rows are touched: queued, sent, failed and canceled rows keep their status, error and timestamp', async () => {
    await withDb(null, (mod) => {
      const past = new Date(Date.now() - 60_000).toISOString()
      for (const id of ['q-queued', 'q-sent', 'q-failed', 'q-canceled']) {
        mod.enqueueSendQueue(1, { to: 'a@test', subject: id }, past, id, null, `<${id}@test>`)
      }
      mod.markSendQueueSending('q-sent'); mod.markSendQueueSent('q-sent')
      mod.markSendQueueSending('q-failed'); mod.markSendQueueFailed('q-failed', 'earlier failure')
      expect(mod.cancelSendQueue('q-canceled')?.status).toBe('canceled')
      for (const id of ['q-queued', 'q-sent', 'q-failed', 'q-canceled']) backdate(mod, id, 10 * 60_000)
      const before = Object.fromEntries(['q-queued', 'q-sent', 'q-failed', 'q-canceled'].map(id => [id, mod.getSendQueueById(id)]))

      expect(mod.failAbandonedSendQueue(ABANDONED)).toEqual([])
      expect(mod.failAbandonedSendQueue(ABANDONED, new Date().toISOString())).toEqual([])
      for (const id of Object.keys(before)) expect(mod.getSendQueueById(id)).toEqual(before[id])
      expect(mod.getSendQueueById('q-failed')?.lastError).toBe('earlier failure')
    })
  })

  testDb('the stored failure text is capped at 4000 characters like every other failure text', async () => {
    await withDb(null, (mod) => {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, new Date().toISOString(), 'q1', null, '<m@test>')
      mod.markSendQueueSending('q1')
      mod.failAbandonedSendQueue('e'.repeat(5000))
      expect(mod.getSendQueueById('q1')?.lastError).toHaveLength(4000)
    })
  })

  testDb('the Message-ID is the same through a transient retry cycle (sending -> queued -> sending) and a later failure', async () => {
    await withDb(null, (mod) => {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, new Date(Date.now() - 1000).toISOString(), 'q1', null, '<stable@test>')
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(mod.markSendQueueSending('q1')).toBe(true)
        expect(mod.getSendQueueById('q1')?.messageId).toBe('<stable@test>')
        // The queue's transient branch.
        expect(mod.rescheduleSendQueue('q1', new Date(Date.now() - 1000).toISOString())).toBe(true)
      }
      mod.markSendQueueSending('q1')
      mod.markSendQueueFailed('q1', 'final')
      expect(mod.getSendQueueById('q1')?.messageId).toBe('<stable@test>')
      expect(mod.cancelSendQueue('q1')?.messageId).toBe('<stable@test>')
    })
  })

  testDb('an empty Message-ID passed to enqueue is stored as absent, so the queue mints one on first use', async () => {
    await withDb(null, (mod) => {
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 's' }, new Date().toISOString(), 'q1', null, '')
      expect(mod.getSendQueueById('q1')?.messageId).toBeNull()
      expect(mod.ensureSendQueueMessageId('q1', '<minted@test>')).toBe('<minted@test>')
    })
  })

  testDb('legacy rows keep what they have across a second start: ids already stored survive, missing ones are still filled once', async () => {
    const seed = (dir: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacy = new (Database as any)(path.join(dir, 'cache.db'))
      legacy.exec(`
        CREATE TABLE send_queue(
          id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, message_data TEXT NOT NULL, send_at TEXT NOT NULL,
          status TEXT NOT NULL, last_error TEXT, attempt_count INTEGER DEFAULT 0, archive_ref TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `)
      const now = new Date().toISOString()
      const insert = legacy.prepare(`INSERT INTO send_queue(id, account_id, message_data, send_at, status, attempt_count, created_at, updated_at)
        VALUES(?, 1, '{"to":"a@test","subject":"legacy"}', ?, ?, 0, ?, ?)`)
      insert.run('q-queued', now, 'queued', now, now)
      insert.run('q-failed', now, 'failed', now, now)
      legacy.close()
    }
    await withDb(seed, async (mod, dir) => {
      // First start after the upgrade: both rows are readable, neither has an id yet.
      expect(mod.getSendQueueById('q-queued')?.messageId).toBeNull()
      expect(mod.ensureSendQueueMessageId('q-queued', '<first@test>')).toBe('<first@test>')
      mod.default.close()

      // Second start: the column already exists, the migration must not fail or reset the stored id.
      vi.resetModules()
      const again = await import('./index')
      try {
        expect(again.getSendQueueById('q-queued')?.messageId).toBe('<first@test>')
        expect(again.getSendQueueById('q-failed')?.messageId).toBeNull()
        expect(again.ensureSendQueueMessageId('q-failed', '<second@test>')).toBe('<second@test>')
        // A manual resend of the failed legacy row reuses the id it got.
        expect(again.sendQueueNow('q-failed')).toBe(true)
        expect(again.listDueSendQueue(new Date(Date.now() + 1000).toISOString(), 10).find(r => r.id === 'q-failed')?.messageId).toBe('<second@test>')
      } finally {
        try { again.default.close() } catch { /* ignore */ }
      }
      expect(fs.existsSync(path.join(dir, 'cache.db'))).toBe(true)
    })
  })
})
