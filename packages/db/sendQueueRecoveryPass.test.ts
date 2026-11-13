import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ABANDONED_SEND_FAILURE_TEXT,
  createSendQueueRecovery,
  type SendQueueRecoveryDeps,
} from '../../electron/services/sendQueueRecovery'

type DbModule = typeof import('./index')

// The real recovery (electron/services/sendQueueRecovery.ts) wired to the real
// send_queue functions, the way electron/main.ts wires them. What matters is
// which `sending` rows a pass may fail: on every pass, the first one included,
// only rows claimed more than two minutes ago (a row being sent right now, by
// this process or by another one over the same database, is not touched).

let betterSqlite3Usable = true
try {
  const mod = await import('better-sqlite3')
  const probe = new (mod.default as unknown as new (p: string) => { close(): void })(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function withDb(fn: (mod: DbModule) => void | Promise<void>) {
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-send-recovery-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  let mod: DbModule | undefined
  try {
    mod = await import('./index')
    await fn(mod)
  } finally {
    try { mod?.default.close() } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
    else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
  }
}

function wire(mod: DbModule) {
  const reported: string[] = []
  const deps: SendQueueRecoveryDeps = {
    failAbandoned: mod.failAbandonedSendQueue,
    reportFailed: row => { reported.push(row.id) },
    reportError: err => { throw err },
    now: () => Date.now(),
  }
  return { recover: createSendQueueRecovery(deps), reported }
}

function enqueueSending(mod: DbModule, id: string, claimedMsAgo: number, messageId: string | null = `<${id}@test>`) {
  mod.enqueueSendQueue(1, { to: 'a@test', subject: id }, new Date(Date.now() - 60_000).toISOString(), id, null, messageId)
  expect(mod.markSendQueueSending(id)).toBe(true)
  mod.default.prepare(`UPDATE send_queue SET updated_at=? WHERE id=?`).run(new Date(Date.now() - claimedMsAgo).toISOString(), id)
}

describe('send queue recovery against the real send_queue', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('first pass: a row left by the previous run is failed once it is older than the cutoff, not requeued, and reported once', async () => {
    await withDb((mod) => {
      // Quit mid-send: the young row is left alone at first, the old one is failed.
      enqueueSending(mod, 'q-young', 5_000)
      enqueueSending(mod, 'q-prev-run', 3 * 60_000)
      const { recover, reported } = wire(mod)

      expect(recover().map(r => r.id)).toEqual(['q-prev-run'])
      expect(mod.getSendQueueById('q-young')?.status).toBe('sending')
      expect(reported).toEqual(['q-prev-run'])
      const row = mod.getSendQueueById('q-prev-run')
      expect(row?.status).toBe('failed')
      expect(row?.lastError).toBe(ABANDONED_SEND_FAILURE_TEXT)
      expect(mod.listDueSendQueue(new Date().toISOString(), 10).map(r => r.id)).not.toContain('q-prev-run')
    })
  })

  testDb('later pass: a row this process claimed a moment ago is not touched, a stale one from another process is failed', async () => {
    await withDb((mod) => {
      const { recover, reported } = wire(mod)
      expect(recover()).toEqual([]) // first pass, nothing abandoned

      enqueueSending(mod, 'q-live', 1_000)
      enqueueSending(mod, 'q-stale', 3 * 60_000)
      expect(recover().map(r => r.id)).toEqual(['q-stale'])

      expect(reported).toEqual(['q-stale'])
      expect(mod.getSendQueueById('q-live')?.status).toBe('sending')
      expect(mod.getSendQueueById('q-stale')?.status).toBe('failed')
      // Once the live send finishes it is marked sent as usual; recovery never reclaimed it.
      expect(mod.markSendQueueSent('q-live')).toBe(true)
      expect(mod.getSendQueueById('q-live')?.status).toBe('sent')
    })
  })

  testDb('no first-pass exception: a fresh recovery (next start) leaves a young row alone until it passes the cutoff', async () => {
    await withDb((mod) => {
      enqueueSending(mod, 'q-young', 1_000)
      // "Restart": a new recovery instance; the row may be another process's live send.
      expect(wire(mod).recover()).toEqual([])
      expect(mod.getSendQueueById('q-young')?.status).toBe('sending')

      mod.default.prepare(`UPDATE send_queue SET updated_at=? WHERE id=?`).run(new Date(Date.now() - 3 * 60_000).toISOString(), 'q-young')
      expect(wire(mod).recover().map(r => r.id)).toEqual(['q-young'])
    })
  })

  testDb('a failed row resent by hand goes out with the Message-ID it was first queued with', async () => {
    await withDb((mod) => {
      enqueueSending(mod, 'q1', 3 * 60_000, '<original@test>')
      wire(mod).recover()
      expect(mod.getSendQueueById('q1')?.messageId).toBe('<original@test>')

      expect(mod.sendQueueNow('q1')).toBe(true)
      const [due] = mod.listDueSendQueue(new Date(Date.now() + 1000).toISOString(), 10)
      expect(due.id).toBe('q1')
      expect(due.messageId).toBe('<original@test>')
      expect(due.lastError).toBeNull()
    })
  })

  testDb('recovery and a manual resend do not invent a Message-ID for a legacy row: the queue mints it on the send itself', async () => {
    await withDb((mod) => {
      enqueueSending(mod, 'q-legacy', 3 * 60_000, null)
      wire(mod).recover()
      expect(mod.getSendQueueById('q-legacy')?.status).toBe('failed')

      mod.sendQueueNow('q-legacy')
      const [due] = mod.listDueSendQueue(new Date(Date.now() + 1000).toISOString(), 10)
      expect(due.id).toBe('q-legacy')
      expect(due.messageId).toBeNull()
    })
  })
})
