import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAIL_RULE_REFUSED_ERROR,
  RULE_OPS,
  RULE_ACTION_TYPES,
  parseMailRuleRefusal,
} from '../core'

type DbModule = typeof import('./index')

// §2.162 — a static mail rule whose firing cannot be justified is refused at the
// STORAGE layer, not only by the callers that exist today.
//
// The two callers (the `rules:create` / `rules:update` IPC handlers and the MCP
// rule tools) refuse earlier and with wording of their own; this file covers the
// last line, which is what makes the guarantee independent of a future caller
// knowing about the rule and of a compromised renderer reaching storage by some
// other route. The DECISION is the pure `findMailRuleRefusal` in packages/core
// and is covered behaviourally in `packages/core/mailRules.test.ts`; what is
// asserted here is that storage asks it, on both write paths, and that the
// refusal it throws decodes with the same decoder the renderer uses.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-mailrule-guard-'))
}

const conditions = (field: string, value = 'boss@example.com'): string =>
  JSON.stringify([{ field, op: 'contains', value }])
/**
 * Actions in the shape storage accepts. `move` gets a target folder because a
 * `move` without one is refused as malformed (§2.162) — a folderless move used
 * to move nothing while the caller logged it as applied.
 */
const actions = (...types: string[]): string =>
  JSON.stringify(types.map((type) => (type === 'move' ? { type, folder: 'Filed' } : { type })))

/**
 * Store a rule directly via SQL, bypassing `createMailRule` entirely.
 *
 * Every rule this guard exists to neutralise predates the guard, and the guard
 * makes it impossible to produce one through the normal path — so a test that
 * needs such a rule in the database must insert it the way a legacy install
 * already has one.
 */
function rawSeedRule(mod: DbModule, conditionsJson: string, actionsJson: string): string {
  const id = `raw-${Math.random().toString(36).slice(2)}`
  const now = new Date().toISOString()
  mod.default.prepare(`
    INSERT INTO mail_rules(id, account_id, name, enabled, priority, conditions, actions, stop_processing, created_at, updated_at)
    VALUES(?, NULL, ?, 1, 0, ?, ?, 0, ?, ?)
  `).run(id, 'legacy rule', conditionsJson, actionsJson, now, now)
  return id
}

describe('mail_rules storage guard (§2.162)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  // ── createMailRule ─────────────────────────────────────────────────────

  testDb('refuses a destructive action gated on the legacy `from` field, and persists nothing', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      for (const type of ['move', 'trash', 'archive', 'mark_spam']) {
        expect(() =>
          mod.createMailRule({
            name: `legacy sender ${type}`,
            conditions: conditions('from'),
            actions: actions(type),
          }),
          type,
        ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      }
      expect(mod.listMailRules()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('allows mark_read and mark_starred on the legacy `from` field', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      for (const type of ['mark_read', 'mark_starred']) {
        const rule = mod.createMailRule({
          name: `legacy sender ${type}`,
          conditions: conditions('from'),
          actions: actions(type),
        })
        expect(rule.id, type).toBeTruthy()
      }
      expect(mod.listMailRules()).toHaveLength(2)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a destructive action gated on the display name (from_name)', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      for (const type of ['move', 'trash', 'archive', 'mark_spam']) {
        expect(() =>
          mod.createMailRule({
            name: `display name ${type}`,
            conditions: conditions('from_name', 'Acme Support'),
            actions: actions(type),
          }),
          type,
        ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      }
      expect(mod.listMailRules()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('allows the display-name field on reversible actions', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rule = mod.createMailRule({
        name: 'star the boss',
        conditions: conditions('from_name', 'Acme Support'),
        actions: actions('mark_starred'),
      })
      expect(rule.id).toBeTruthy()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a rule that is not shaped like a rule', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // Syntactically valid JSON of the wrong shape — the form the MCP tools
      // can be talked into producing, since a model authors the JSON. Stored,
      // it used to throw inside `matchRule` once per message.
      for (const [conds, acts] of [
        ['{}', '[{"type":"trash"}]'],
        ['[42]', '[{"type":"trash"}]'],
        ['[{"field":"subject"}]', '[{"type":"trash"}]'],
        ['[{"field":"subject","op":"contains","value":"x"}]', '{"type":"trash"}'],
        ['not json at all', '[]'],
      ]) {
        expect(() =>
          mod.createMailRule({ name: 'broken', conditions: conds, actions: acts }),
          conds,
        ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      }
      expect(mod.listMailRules()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses an operator or action type outside the engine vocabularies', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      expect(() =>
        mod.createMailRule({
          name: 'typo in operator',
          conditions: JSON.stringify([{ field: 'subject', op: 'contain', value: 'x' }]),
          actions: actions('mark_read'),
        }),
      ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))

      expect(() =>
        mod.createMailRule({
          name: 'action nobody implements',
          conditions: conditions('subject', 'x'),
          actions: JSON.stringify([{ type: 'delete' }]),
        }),
      ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))

      expect(mod.listMailRules()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('accepts every operator and action type the engine implements', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      for (const op of RULE_OPS) {
        const rule = mod.createMailRule({
          name: `op ${op}`,
          conditions: JSON.stringify([{ field: 'subject', op, value: 'x' }]),
          actions: actions('mark_read'),
        })
        expect(rule.id, op).toBeTruthy()
      }
      for (const type of RULE_ACTION_TYPES) {
        const rule = mod.createMailRule({
          name: `action ${type}`,
          conditions: conditions('from_address'),
          actions: actions(type),
        })
        expect(rule.id, type).toBeTruthy()
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a move that names no target folder', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      for (const acts of ['[{"type":"move"}]', '[{"type":"move","folder":"   "}]']) {
        expect(() =>
          mod.createMailRule({
            name: 'move to nowhere',
            conditions: conditions('from_address'),
            actions: acts,
          }),
          acts,
        ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      }
      expect(mod.listMailRules()).toEqual([])

      // With a target it stores normally.
      const ok = mod.createMailRule({
        name: 'file the invoices',
        conditions: conditions('from_address'),
        actions: JSON.stringify([{ type: 'move', folder: 'Invoices' }]),
      })
      expect(ok.actions).toContain('Invoices')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a patch that drops the target folder off a stored move rule', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rule = mod.createMailRule({
        name: 'file the invoices',
        conditions: conditions('from_address'),
        actions: JSON.stringify([{ type: 'move', folder: 'Invoices' }]),
      })

      expect(() => mod.updateMailRule(rule.id, { actions: '[{"type":"move"}]' }))
        .toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      expect(mod.getMailRule(rule.id)?.actions).toContain('Invoices')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a patch that would leave a structurally broken rule behind', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rule = mod.createMailRule({
        name: 'well formed',
        conditions: conditions('from_address'),
        actions: actions('trash'),
      })

      expect(() => mod.updateMailRule(rule.id, { conditions: '[{"field":"subject"}]' }))
        .toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      expect(mod.getMailRule(rule.id)?.conditions).toBe(conditions('from_address'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a condition on `cc`, which this client never stores', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      expect(() =>
        mod.createMailRule({
          name: 'cc rule',
          conditions: conditions('cc'),
          actions: actions('mark_read'),
        }),
      ).toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      expect(mod.listMailRules()).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('stores a well-formed destructive rule unchanged', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rule = mod.createMailRule({
        name: 'trash a known sender',
        conditions: conditions('from_address'),
        actions: actions('trash'),
      })
      expect(rule.conditions).toBe(conditions('from_address'))
      expect(rule.actions).toBe(actions('trash'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the refusal decodes with the renderer-side decoder and names the field', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      let thrown: unknown
      try {
        mod.createMailRule({
          name: 'legacy sender trash',
          conditions: conditions('from'),
          actions: actions('trash'),
        })
      } catch (err) {
        thrown = err
      }
      // One decoder, one user-visible outcome — whichever layer refused.
      expect(parseMailRuleRefusal(thrown)).toEqual({
        reason: 'unverifiable_sender',
        field: 'from',
        action: 'trash',
      })
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // ── updateMailRule ─────────────────────────────────────────────────────

  testDb('refuses a patch that swaps the actions of a stored legacy-`from` rule to a destructive one', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // The bypass this covers: the patch itself carries no condition, so a
      // check on the submitted half alone sees only `[{type:"trash"}]`.
      const rule = mod.createMailRule({
        name: 'legacy sender',
        conditions: conditions('from'),
        actions: actions('mark_read'),
      })

      expect(() => mod.updateMailRule(rule.id, { actions: actions('trash') }))
        .toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))

      // Nothing was written: the stored rule still marks as read.
      expect(mod.getMailRule(rule.id)?.actions).toBe(actions('mark_read'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('refuses a patch that swaps the conditions of a stored destructive rule to the legacy field', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rule = mod.createMailRule({
        name: 'trash a known sender',
        conditions: conditions('from_address'),
        actions: actions('trash'),
      })

      expect(() => mod.updateMailRule(rule.id, { conditions: conditions('from') }))
        .toThrow(new RegExp(MAIL_RULE_REFUSED_ERROR))
      expect(mod.getMailRule(rule.id)?.conditions).toBe(conditions('from_address'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('lets the user DISABLE a rule stored before the guard existed', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const id = rawSeedRule(mod, conditions('from'), actions('trash'))

      // The one action that neutralises such a rule must not be the one the
      // guard blocks: the patch touches neither half, so it is not checked.
      const updated = mod.updateMailRule(id, { enabled: false })
      expect(updated?.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('lets the user rename and re-prioritise a rule stored before the guard existed', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const id = rawSeedRule(mod, conditions('cc'), actions('trash'))

      const updated = mod.updateMailRule(id, { name: 'renamed', priority: 7, stopProcessing: true })
      expect(updated?.name).toBe('renamed')
      expect(updated?.priority).toBe(7)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('lets the user REPAIR a rule stored before the guard existed', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const id = rawSeedRule(mod, conditions('from'), actions('trash'))

      // Migrating the sender condition to the verifiable field is exactly what
      // the user is asked to do, so it must go through while the actions stay
      // destructive.
      const updated = mod.updateMailRule(id, { conditions: conditions('from_address') })
      expect(updated?.conditions).toBe(conditions('from_address'))
      expect(updated?.actions).toBe(actions('trash'))
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a patch for a rule that does not exist still reports "not found", not a refusal', async () => {
    const dir = mkdir()
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      expect(mod.updateMailRule('no-such-rule', { actions: actions('trash') })).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
