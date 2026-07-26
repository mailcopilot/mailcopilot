import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AI_RULE_MAX_ENABLED_PER_ACCOUNT, AI_RULE_ENABLED_LIMIT_ERROR } from '../core'

type DbModule = typeof import('./index')

// §2.39 — the per-account enabled-rule cap is enforced at the storage layer, so
// the atomic-per-account pipeline always has a rule set that fits one hourly
// window. createAiRule (enabled create) and updateAiRule (enable transition)
// must reject an enable that would push any affected account past the cap, with
// a machine-detectable error token the renderer can localize.

let betterSqlite3Usable = true
try {
  const mod = await import('better-sqlite3')
  const probe = new (mod.default as unknown as new (p: string) => { close(): void })(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function loadDbModule(dir: string): Promise<{ mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  const mod = await import('./index')
  return { mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule, prevDataDir: string | undefined) {
  try { mod.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-cap-'))
}

/** Create `count` ENABLED rules for a given account scope, one at a time,
 *  through the real createAiRule (which enforces the cap). Returns the ids. */
function seedEnabledRules(mod: DbModule, accountId: string | null, count: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const r = mod.createAiRule({
      accountId,
      name: `rule ${accountId ?? 'global'} ${i}`,
      prompt: 'classify',
      allowedActions: '["archive"]',
      enabled: true,
    })
    ids.push(r.id)
  }
  return ids
}

/** Raw-seed `count` ENABLED rules for an account scope directly via SQL,
 *  bypassing createAiRule's cap enforcement entirely. Used to reproduce a
 *  genuinely over-cap legacy account (createAiRule/updateAiRule can never
 *  produce one through the normal path — that's the whole point of the cap —
 *  so a test that wants to prove such an account exists in a pre-existing DB
 *  must insert it directly, the same way a legacy DB predating the cap could). */
function rawSeedEnabledRules(mod: DbModule, accountId: string | null, count: number): string[] {
  const ids: string[] = []
  const now = new Date().toISOString()
  const insert = mod.default.prepare(`
    INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?)
  `)
  for (let i = 0; i < count; i++) {
    const id = `raw-${accountId ?? 'global'}-${i}-${Math.random().toString(36).slice(2)}`
    insert.run(id, accountId, `raw rule ${accountId ?? 'global'} ${i}`, 'classify', '["archive"]', 0.5, now, now)
    ids.push(id)
  }
  return ids
}

describe('ai_rules per-account enabled cap (§2.39)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('createAiRule allows enabling up to the cap for one account', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const ids = seedEnabledRules(mod, '1', AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      expect(ids).toHaveLength(AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      const enabledCount = mod.listAiRules('1').filter(r => r.enabled).length
      expect(enabledCount).toBe(AI_RULE_MAX_ENABLED_PER_ACCOUNT)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('createAiRule rejects an enabled create that would exceed the cap', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      seedEnabledRules(mod, '1', AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      expect(() =>
        mod.createAiRule({
          accountId: '1',
          name: 'over the cap',
          prompt: 'p',
          allowedActions: '["archive"]',
          enabled: true,
        }),
      ).toThrow(new RegExp(AI_RULE_ENABLED_LIMIT_ERROR))
      // Nothing was persisted for the rejected rule (still exactly the cap).
      expect(mod.listAiRules('1').filter(r => r.enabled).length).toBe(AI_RULE_MAX_ENABLED_PER_ACCOUNT)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a DISABLED create past the cap is always allowed (no enabled count change)', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      seedEnabledRules(mod, '1', AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      const created = mod.createAiRule({
        accountId: '1',
        name: 'disabled extra',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: false,
      })
      expect(created.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateAiRule rejects the enable transition that would exceed the cap', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      seedEnabledRules(mod, '1', AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      const disabled = mod.createAiRule({
        accountId: '1',
        name: 'to be enabled',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: false,
      })
      expect(() => mod.updateAiRule(disabled.id, { enabled: true })).toThrow(
        new RegExp(AI_RULE_ENABLED_LIMIT_ERROR),
      )
      // The rule stays disabled (transition rejected before the UPDATE).
      expect(mod.getAiRule(disabled.id)?.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateAiRule allows disabling and non-enable edits unconditionally', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const ids = seedEnabledRules(mod, '1', AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      // Disabling one of the enabled rules is always fine (count goes DOWN).
      const disabled = mod.updateAiRule(ids[0], { enabled: false })
      expect(disabled?.enabled).toBe(false)
      // Editing an already-enabled rule (no enable transition) is fine even at
      // the cap — it does not increase any account's enabled count.
      const edited = mod.updateAiRule(ids[1], { name: 'renamed' })
      expect(edited?.name).toBe('renamed')
      expect(edited?.enabled).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a global rule counts toward every account (global bucket cap)', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // Fill the GLOBAL bucket to the cap; a further enabled global overflows the
      // bucket every account inherits.
      seedEnabledRules(mod, null, AI_RULE_MAX_ENABLED_PER_ACCOUNT)
      expect(() =>
        mod.createAiRule({
          accountId: null,
          name: 'one global too many',
          prompt: 'p',
          allowedActions: '["archive"]',
          enabled: true,
        }),
      ).toThrow(new RegExp(AI_RULE_ENABLED_LIMIT_ERROR))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateAiRule rejects enabling a global rule that overflows an account (globals + scoped)', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // (cap - 1) enabled globals + 1 enabled account-1 rule = cap enabled rules
      // applicable to account 1. A DISABLED extra global then exists; enabling it
      // would make account 1 inherit (cap - 1) + 1 new global = cap globals PLUS
      // its own 1 scoped rule = cap + 1 → must be rejected via the global-candidate
      // path (which is checked against every present account bucket).
      seedEnabledRules(mod, null, AI_RULE_MAX_ENABLED_PER_ACCOUNT - 1)
      const acct1 = mod.createAiRule({
        accountId: '1',
        name: 'acct-1 scoped',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: true,
      })
      expect(acct1.enabled).toBe(true)
      // A disabled global that, once enabled, overflows account 1 via globals+scoped.
      const disabledGlobal = mod.createAiRule({
        accountId: null,
        name: 'global to enable',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: false,
      })
      expect(() => mod.updateAiRule(disabledGlobal.id, { enabled: true })).toThrow(
        new RegExp(AI_RULE_ENABLED_LIMIT_ERROR),
      )
      // The global stays disabled — the enable transition was rejected pre-UPDATE.
      expect(mod.getAiRule(disabledGlobal.id)?.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a legacy over-cap account does not block enabling a scoped rule on a different account', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // Simulate a GENUINELY over-cap legacy account 2 by raw-seeding cap + 1
      // enabled rules directly via SQL — createAiRule can never produce this
      // through the normal path (that's the cap doing its job), so a raw INSERT
      // is the only way to reproduce a pre-existing legacy DB that predates the
      // cap. This is strictly past the boundary a `cap`-sized seed would probe,
      // so it also exercises canEnableAiRule's per-scope counting with an input
      // the old (buggy, cross-account) implementation would have rejected.
      rawSeedEnabledRules(mod, '2', AI_RULE_MAX_ENABLED_PER_ACCOUNT + 1)
      expect(mod.listAiRules('2').filter(r => r.enabled).length).toBe(AI_RULE_MAX_ENABLED_PER_ACCOUNT + 1)

      // Enabling a NEW scoped rule on account 1 must still be allowed — account 2
      // is a different scope and must not veto account 1 (fix #4 at the DB layer),
      // even though account 2 is now past the cap, not merely at it.
      const acct1 = mod.createAiRule({
        accountId: '1',
        name: 'acct-1 first',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: true,
      })
      expect(acct1.enabled).toBe(true)
      // Enabling it via updateAiRule (from a disabled create) is also allowed.
      const acct1b = mod.createAiRule({
        accountId: '1',
        name: 'acct-1 second (disabled)',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: false,
      })
      const enabled = mod.updateAiRule(acct1b.id, { enabled: true })
      expect(enabled?.enabled).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('globals + a per-account rule are counted together against the cap', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // (cap - 1) enabled globals; account 1 then has room for exactly ONE more.
      seedEnabledRules(mod, null, AI_RULE_MAX_ENABLED_PER_ACCOUNT - 1)
      const first = mod.createAiRule({
        accountId: '1',
        name: 'acct-1 fits',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: true,
      })
      expect(first.enabled).toBe(true)
      // A SECOND per-account rule for account 1 would be cap+1 → rejected.
      expect(() =>
        mod.createAiRule({
          accountId: '1',
          name: 'acct-1 overflow',
          prompt: 'p',
          allowedActions: '["archive"]',
          enabled: true,
        }),
      ).toThrow(new RegExp(AI_RULE_ENABLED_LIMIT_ERROR))
      // A DIFFERENT account (2) has its own headroom on top of the shared globals.
      const other = mod.createAiRule({
        accountId: '2',
        name: 'acct-2 fits',
        prompt: 'p',
        allowedActions: '["archive"]',
        enabled: true,
      })
      expect(other.enabled).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
