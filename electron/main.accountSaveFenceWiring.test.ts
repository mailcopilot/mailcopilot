import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'

/**
 * WIRING PIN (source-level) — every write to an existing account record goes
 * through `saveAccountFenced`, the per-id queue that also runs the save guard on
 * the record the write will overwrite.
 *
 * The BEHAVIOURAL proof lives in `services/accountSaveFence.test.ts` and
 * `services/accountSaveGuardOrdering.test.ts`. Both start at `saveAccountFenced`
 * and cannot see the three call sites below, because they live in files no test
 * imports (`electron/main.ts` is a 10k-line hotspot with module-load side
 * effects; `outlookOAuthService.ts` is covered by its own tests with
 * `saveAccount` mocked). A site that calls `saveAccount` directly bypasses the
 * queue and the in-queue guard, and nothing else fails.
 *
 * Pinned, per site: the scope calls `saveAccountFenced(saveAccount, …)` exactly
 * once, and `saveAccount` appears nowhere else in it — not called directly, not
 * aliased. Plus: the module imports `saveAccountFenced` from its module. Each
 * check has a mutation control that feeds it the broken shape.
 */

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8')
const MAIN_TS = read('main.ts')
const OUTLOOK_TS = read('services/outlookOAuthService.ts')

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile('under-test.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

const calleeText = (call: ts.CallExpression): string => call.expression.getText()

/** The arrow/function expression registered by `handleIpc('<channel>', ...)`. */
function ipcHandler(file: ts.SourceFile, channel: string): ts.Node | null {
  let found: ts.Node | null = null
  walk(file, n => {
    if (!ts.isCallExpression(n) || calleeText(n) !== 'handleIpc') return
    const [first, second] = n.arguments
    if (first && ts.isStringLiteralLike(first) && first.text === channel && second && (ts.isArrowFunction(second) || ts.isFunctionExpression(second))) found = second
  })
  return found
}

function functionDeclaration(file: ts.SourceFile, name: string): ts.Node | null {
  return file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name) ?? null
}

/**
 * Violations of "inside `scope`, `saveAccount` is used only as the first argument
 * of exactly one `saveAccountFenced(...)` call".
 */
function checkScope(label: string, scope: ts.Node | null): string[] {
  if (!scope) return [`${label}: scope not found`]
  const violations: string[] = []
  const fencedCalls: ts.CallExpression[] = []
  walk(scope, n => { if (ts.isCallExpression(n) && calleeText(n) === 'saveAccountFenced') fencedCalls.push(n) })
  if (fencedCalls.length !== 1) violations.push(`${label}: expected exactly one saveAccountFenced(...) call, found ${fencedCalls.length}`)
  for (const call of fencedCalls) {
    if (call.arguments[0]?.getText() !== 'saveAccount') violations.push(`${label}: saveAccountFenced is not given saveAccount as its first argument`)
    // (saveAccount, input) or (saveAccount, input, gate): the gate is the in-queue refusal of the guard.
    if (call.arguments.length < 2 || call.arguments.length > 3) violations.push(`${label}: saveAccountFenced must receive (saveAccount, input[, gate])`)
  }
  const allowed = new Set(fencedCalls.map(c => c.arguments[0]).filter(Boolean))
  walk(scope, n => {
    if (ts.isIdentifier(n) && n.text === 'saveAccount' && !allowed.has(n)) {
      // A property name (`x.saveAccount`) or a declaration of something else is not a use of the import.
      const parent = n.parent
      if (ts.isPropertyAccessExpression(parent) && parent.name === n) return
      // `{ saveAccount: (input) => saveAccountFenced(saveAccount, input) }` — the key names a dependency slot, it is not a use of the import.
      if (ts.isPropertyAssignment(parent) && parent.name === n) return
      violations.push(`${label}: saveAccount is used outside saveAccountFenced(...)`)
    }
  })
  return violations
}

/**
 * Violations of "the fenced call in `scope` hands the guard's `gate` to the fence". Without it the guard
 * is checked only before the queue, and a save queued behind another one of the same id is judged against
 * a record that may already have been replaced: no failure anywhere, the window just returns.
 */
function checkGatePassed(label: string, scope: ts.Node | null): string[] {
  if (!scope) return [`${label}: scope not found`]
  const calls: ts.CallExpression[] = []
  walk(scope, n => { if (ts.isCallExpression(n) && calleeText(n) === 'saveAccountFenced') calls.push(n) })
  return calls.length === 1 && calls[0].arguments[2]?.getText() === 'gate' ? [] : [`${label}: saveAccountFenced is not given the gate as its third argument`]
}

/** Violations of "`saveAccountFenced` is imported from `<module>`". */
function checkImport(label: string, source: string, moduleSpecifier: string): string[] {
  const file = parse(source)
  const ok = file.statements.some(stmt => {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== moduleSpecifier) return false
    const named = stmt.importClause?.namedBindings
    return !!named && ts.isNamedImports(named) && named.elements.some(e => e.name.text === 'saveAccountFenced' && !e.propertyName)
  })
  return ok ? [] : [`${label}: saveAccountFenced is not imported from ${moduleSpecifier}`]
}

const checkAccountsSave = (source: string) => checkScope('accounts:save', ipcHandler(parse(source), 'accounts:save'))
const checkGoogleConnect = (source: string) => checkScope('oauth:google:connect', ipcHandler(parse(source), 'oauth:google:connect'))
const checkOutlook = (source: string) => checkScope('doConnectOutlookAccount', functionDeclaration(parse(source), 'doConnectOutlookAccount'))

describe('WIRING PIN — account saves go through the per-id queue', () => {
  // Fails if `accounts:save` goes back to `await saveAccount(parsed)`.
  it('accounts:save calls saveAccountFenced(saveAccount, …) and never saveAccount directly', () => {
    expect(checkAccountsSave(MAIN_TS)).toEqual([])
  })

  // Fails if the Google re-authorisation path is reverted (an existing id can be re-authorised to another user).
  it('oauth:google:connect calls saveAccountFenced(saveAccount, …) and never saveAccount directly', () => {
    expect(checkGoogleConnect(MAIN_TS)).toEqual([])
  })

  // Fails if the gate is dropped: the guard would again be judged before the queue only.
  it('accounts:save and oauth:google:connect hand the gate to the fence', () => {
    expect(checkGatePassed('accounts:save', ipcHandler(parse(MAIN_TS), 'accounts:save'))).toEqual([])
    expect(checkGatePassed('oauth:google:connect', ipcHandler(parse(MAIN_TS), 'oauth:google:connect'))).toEqual([])
  })

  // Fails if the Outlook re-authorisation path is reverted.
  it('the Outlook connect flow calls saveAccountFenced(saveAccount, …) and never saveAccount directly', () => {
    expect(checkOutlook(OUTLOOK_TS)).toEqual([])
  })

  it('main.ts and outlookOAuthService.ts import saveAccountFenced from the fence module', () => {
    expect(checkImport('main.ts', MAIN_TS, './services/accountSaveFence')).toEqual([])
    expect(checkImport('outlookOAuthService.ts', OUTLOOK_TS, './accountSaveFence')).toEqual([])
  })
})

describe('WIRING PIN — mutation controls (the checks above can actually fail)', () => {
  // `accounts:save` and the Google connect call hand the fenced saver to a guard/service as a dependency, so
  // the same call text appears at both sites. The text that follows each one tells them apart.
  const FENCED = 'saveAccount: (input, gate) => saveAccountFenced(saveAccount, input, gate),'
  const SAVE_SITE = `${FENCED}\n  })`
  const GOOGLE_SITE = `${FENCED}\n    setRefreshToken`
  const mutate = (source: string, from: string, to: string): string => {
    expect(source.split(from).length, `anchor not found exactly once: ${from.slice(0, 60)}`).toBe(2)
    return source.replace(from, to)
  }

  it('detects accounts:save reverted to a direct saveAccount call', () => {
    const mutated = mutate(MAIN_TS, SAVE_SITE, 'saveAccount,\n  })')
    expect(checkAccountsSave(mutated)).not.toEqual([])
    expect(checkGoogleConnect(mutated)).toEqual([])
  })

  it('detects oauth:google:connect reverted to a direct saveAccount call', () => {
    const start = MAIN_TS.indexOf("handleIpc('oauth:google:connect'")
    const at = MAIN_TS.indexOf(GOOGLE_SITE, start)
    expect(start).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(start)
    const mutated = MAIN_TS.slice(0, at) + 'saveAccount,\n    setRefreshToken' + MAIN_TS.slice(at + GOOGLE_SITE.length)
    expect(checkGoogleConnect(mutated)).not.toEqual([])
    expect(checkAccountsSave(mutated)).toEqual([])
  })

  it('detects the Outlook flow reverted to a direct saveAccount call', () => {
    const mutated = mutate(OUTLOOK_TS, 'await saveAccountFenced(saveAccount, {', 'await saveAccount({')
    expect(checkOutlook(mutated)).not.toEqual([])
  })

  it('detects a second, unfenced saveAccount call added next to the fenced one', () => {
    const mutated = mutate(MAIN_TS, SAVE_SITE, `${SAVE_SITE}\n  await saveAccount(parsed)`)
    expect(checkAccountsSave(mutated)).not.toEqual([])
  })

  it('detects saveAccount aliased and called through the alias', () => {
    const mutated = mutate(MAIN_TS, SAVE_SITE, 'saveAccount: (input) => { const direct = saveAccount; return direct(input) },\n  })')
    expect(checkAccountsSave(mutated)).not.toEqual([])
  })

  it('detects the fence handed some other saver', () => {
    const mutated = mutate(MAIN_TS, SAVE_SITE, 'saveAccount: (input, gate) => saveAccountFenced(async () => ({ id: 1 }), input, gate),\n  })')
    expect(checkAccountsSave(mutated)).not.toEqual([])
  })

  it('detects the gate dropped from either site', () => {
    const noGate = mutate(MAIN_TS, SAVE_SITE, SAVE_SITE.replace('(input, gate)', '(input)').replace('input, gate)', 'input)'))
    expect(checkGatePassed('accounts:save', ipcHandler(parse(noGate), 'accounts:save'))).not.toEqual([])
    expect(checkGatePassed('oauth:google:connect', ipcHandler(parse(noGate), 'oauth:google:connect'))).toEqual([])
    const noGateGoogle = mutate(MAIN_TS, GOOGLE_SITE, GOOGLE_SITE.replace('(input, gate)', '(input)').replace('input, gate)', 'input)'))
    expect(checkGatePassed('oauth:google:connect', ipcHandler(parse(noGateGoogle), 'oauth:google:connect'))).not.toEqual([])
  })

  it('detects the fenced call removed altogether', () => {
    const mutated = mutate(MAIN_TS, SAVE_SITE, 'saveAccount: async () => ({ id: 1 }),\n  })')
    expect(checkAccountsSave(mutated)).not.toEqual([])
  })

  it('detects the import removed', () => {
    const mutated = mutate(MAIN_TS, "import { saveAccountFenced } from './services/accountSaveFence'\n", '')
    expect(checkImport('main.ts', mutated, './services/accountSaveFence')).not.toEqual([])
  })
})
