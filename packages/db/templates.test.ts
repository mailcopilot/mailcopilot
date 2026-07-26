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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-templates-test-'))
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

describe('packages/db templates', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('createTemplate + listTemplates', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const tpl = mod.createTemplate('Greeting', 'Hello!', 'Hi {name}', 'greet')
      expect(tpl.id).toBeGreaterThan(0)
      expect(tpl.name).toBe('Greeting')
      expect(tpl.subject).toBe('Hello!')
      expect(tpl.body).toBe('Hi {name}')
      expect(tpl.shortcut).toBe('greet')

      const list = mod.listTemplates()
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe('Greeting')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getTemplate returns a template by id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const tpl = mod.createTemplate('Test', 'Subj', 'Body')
      const found = mod.getTemplate(tpl.id)
      expect(found).toBeDefined()
      expect(found!.name).toBe('Test')

      expect(mod.getTemplate(999)).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateTemplate updates fields', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const tpl = mod.createTemplate('Old Name', 'Old Subj', 'Old Body')

      const updated = mod.updateTemplate(tpl.id, { name: 'New Name', body: 'New Body' })
      expect(updated).toBeDefined()
      expect(updated!.name).toBe('New Name')
      expect(updated!.subject).toBe('Old Subj') // unchanged
      expect(updated!.body).toBe('New Body')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateTemplate with non-existent id returns undefined', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.updateTemplate(999, { name: 'X' })).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteTemplate deletes a template', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const tpl = mod.createTemplate('ToDelete', '', '')
      expect(mod.deleteTemplate(tpl.id)).toBe(true)
      expect(mod.listTemplates()).toHaveLength(0)

      // Repeated deletion — false
      expect(mod.deleteTemplate(tpl.id)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listTemplates sorts by updated_at DESC (last created first)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createTemplate('Banana', '', '')
      mod.createTemplate('Apple', '', '')
      mod.createTemplate('Cherry', '', '')

      const names = mod.listTemplates().map(t => t.name)
      // ORDER BY updated_at DESC — last created goes first
      expect(names).toEqual(['Cherry', 'Apple', 'Banana'])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
