import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

// better-sqlite3 ABI probe — skip tests if native module doesn't match
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-offline-ops-test-'))
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

describe('offlineOps', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('upsertOfflineOp inserts a new op', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0]).toMatchObject({
        accountId: 1,
        folder: 'INBOX',
        uid: 100,
        opType: 'flag_seen',
        payload: { seen: true },
      })
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertOfflineOp deduplicates by (account, folder, uid, opType)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: false })
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0].payload).toEqual({ seen: false })
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertOfflineOp creates separate entries for different opTypes', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_flagged', { flagged: true })
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getOfflineOps returns ops ordered by created_at', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 101, 'flag_flagged', { flagged: true })
      mod.upsertOfflineOp(1, 'Sent', 200, 'move', { destFolder: 'Archive' })
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(3)
      expect(ops[0].uid).toBe(100)
      expect(ops[1].uid).toBe(101)
      expect(ops[2].uid).toBe(200)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getOfflineOps filters by accountId', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(2, 'INBOX', 200, 'flag_seen', { seen: true })
      expect(mod.getOfflineOps(1)).toHaveLength(1)
      expect(mod.getOfflineOps(2)).toHaveLength(1)
      expect(mod.getOfflineOps()).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteOfflineOp removes a single op by id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 101, 'flag_flagged', { flagged: true })
      const ops = mod.getOfflineOps(1)
      mod.deleteOfflineOp(ops[0].id)
      const remaining = mod.getOfflineOps(1)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].uid).toBe(101)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteOfflineOpsForFolder removes all ops for a folder', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      mod.upsertOfflineOp(1, 'INBOX', 101, 'flag_flagged', { flagged: true })
      mod.upsertOfflineOp(1, 'Sent', 200, 'flag_seen', { seen: true })
      mod.deleteOfflineOpsForFolder(1, 'INBOX')
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0].folder).toBe('Sent')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertOfflineOp stores uidValidity', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true }, 42)
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0].uidValidity).toBe(42)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertOfflineOp stores null uidValidity when not provided', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'flag_seen', { seen: true })
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0].uidValidity).toBeNull()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertOfflineOp supports delete opType', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertOfflineOp(1, 'INBOX', 100, 'delete', undefined, 99)
      const ops = mod.getOfflineOps(1)
      expect(ops).toHaveLength(1)
      expect(ops[0].opType).toBe('delete')
      expect(ops[0].payload).toBeNull()
      expect(ops[0].uidValidity).toBe(99)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})

describe('syncState', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('getSyncState returns undefined for missing entry', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const state = mod.getSyncState(1, 'INBOX')
      expect(state).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertSyncState creates and updates sync state', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertSyncState(1, 'INBOX', '12345', 100)
      const state = mod.getSyncState(1, 'INBOX')
      expect(state).toBeDefined()
      expect(state!.highestModseq).toBe('12345')
      expect(state!.uidValidity).toBe(100)
      expect(state!.lastFullSync).toBeTruthy()

      // Update
      mod.upsertSyncState(1, 'INBOX', '99999', 100)
      const updated = mod.getSyncState(1, 'INBOX')
      expect(updated!.highestModseq).toBe('99999')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
