import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * §2.218 — the `subscription` AI provider was REMOVED (Anthropic's Consumer
 * Terms permit Free/Pro/Max credentials only in Claude Code and Claude.ai, so
 * driving such a session from a third-party client risks the USER's account).
 * Removing it from the type system is not enough on its own: the value can
 * still arrive from outside the process — a stale Settings window mid-upgrade,
 * a settings record written by an older build, or a compromised renderer.
 *
 * This suite pins the two boundaries that decide what happens then:
 *
 *   1. WRITERS reject it. Every renderer-reachable IPC entry point that accepts
 *      a provider parses against the single `aiProviderSchema`, so no NEW row
 *      or request can carry the removed id.
 *   2. The RESUME path cannot be steered by a legacy row. Both branches are
 *      positive equality checks against live providers, so an unknown or
 *      dropped provider falls out of all of them rather than into one.
 *
 * Reads stay deliberately opaque — the append-only audit log, the cost ledger
 * and persisted session rows keep rendering ids that are no longer selectable.
 * That asymmetry (strict in, tolerant out) is asserted below too, because
 * "tighten it everywhere" is the plausible wrong fix and it would blank the
 * user's own audit trail.
 *
 * `main.ts` is not importable (module-level side effects: window creation, IPC
 * registration, DB open at import time), so — like `main.settingsClamp.test.ts`
 * and `main.standaloneWindows.test.ts` before it — this suite reads the source.
 * Every assertion is anchored to production text, so it fails the moment a call
 * site drops the shared schema or flips a branch to a negative check.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

/** The provider set as `main.ts` actually declares it, parsed out of source. */
const declaredProviders = (() => {
  const m = MAIN_TS.match(/const aiProviderSchema = z\.enum\(\[([^\]]*)\]\)/)
  if (!m) return null
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
})()

describe('§2.218 main.ts — one provider schema, and it excludes the removed provider', () => {
  it('declares exactly the three key-based providers', () => {
    expect(declaredProviders).not.toBeNull()
    expect(declaredProviders).toEqual(['anthropic-api', 'openai-api', 'gemini-api'])
  })

  it('never names the removed provider in a live enum', () => {
    expect(declaredProviders).not.toContain('subscription')
  })

  // The regression this guards: someone adds a sixth provider-accepting channel
  // and hand-writes the enum again. Five copies is how `aiSession:create` was
  // left behind on `z.string().min(1)` in the first place.
  it('leaves no hand-written copy of the enum literal behind', () => {
    const copies = MAIN_TS.match(/z\.enum\(\[\s*'anthropic-api'/g) ?? []
    expect(copies).toHaveLength(1)
  })
})

describe('§2.218 main.ts — every provider-accepting WRITER uses the shared schema', () => {
  /** Body of a `handleIpc('<channel>', ...)` registration, by brace balance. */
  function handlerBody(channel: string): string {
    const start = MAIN_TS.indexOf(`handleIpc('${channel}'`)
    expect(start, `handler for ${channel} not found`).toBeGreaterThan(-1)
    return MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
  }

  // `aiSession:create` is the one this fix-wave closed: it took
  // `provider: z.string().min(1)`, so any non-empty string minted a session row
  // — including a fresh `subscription` one, written AFTER the removal.
  it('aiSession:create validates the provider against the live set', () => {
    const body = handlerBody('aiSession:create')
    expect(body).toContain('provider: aiProviderSchema')
    expect(body).not.toMatch(/provider:\s*z\.string\(\)/)
  })

  it.each([
    'ai:chat',
    'ai:checkAuth',
    'ai:saveApiKey',
    'ai:deleteApiKey',
  ])('%s parses its provider through aiProviderSchema', (channel) => {
    expect(handlerBody(channel)).toContain('aiProviderSchema')
  })

  // THE OTHER SIDE OF THE ASYMMETRY, pinned so nobody "finishes the job".
  // `ai:auditLog:list` takes a provider FILTER, and it must stay a loose string:
  // the audit log is append-only history that legitimately contains ids no
  // longer in the live set (`subscription` among them), and filtering by one is
  // a reasonable thing for the privacy panel to ask. Tightening this read to
  // `aiProviderSchema` would make the user's own removed-provider rows
  // unfilterable — the AC-3 contract in reverse.
  it('leaves the audit-log READ filter as an opaque string', () => {
    const start = MAIN_TS.indexOf('const aiAuditListSchema')
    const body = MAIN_TS.slice(start, MAIN_TS.indexOf('})', start))
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/provider: z\.string\(\)/)
    expect(body).not.toContain('aiProviderSchema')
  })

  // Behavioural half: the schema shape itself refuses the removed id and keeps
  // accepting every live one. Reproduced from the parsed source so it cannot
  // drift from what main.ts declares.
  it('the declared schema rejects the removed provider and accepts the live ones', () => {
    const schema = z.enum(declaredProviders as [string, ...string[]])
    expect(schema.safeParse('subscription').success).toBe(false)
    expect(schema.safeParse('').success).toBe(false)
    expect(schema.safeParse('anthropic-api').success).toBe(true)
    expect(schema.safeParse('openai-api').success).toBe(true)
    expect(schema.safeParse('gemini-api').success).toBe(true)
  })
})

describe('§2.218 main.ts — a legacy session cannot steer the resume path', () => {
  /** The `if (sid) { ... }` block inside the `ai:chat` handler. */
  const resumeBlock = (() => {
    const chatStart = MAIN_TS.indexOf("handleIpc('ai:chat'")
    const anchor = MAIN_TS.indexOf('const effectiveProvider = provider || getSettings().aiProvider', chatStart)
    return anchor > -1 ? MAIN_TS.slice(anchor, MAIN_TS.indexOf('\n  }', anchor)) : ''
  })()

  it('resolves the effective provider from settings, never from the session row', () => {
    expect(resumeBlock).not.toBe('')
    // Scoped to the ASSIGNMENT of `effectiveProvider`: that is the decision
    // INPUT, and it must come from the settings provider (or an explicit
    // per-request override) alone. If it ever starts reading `session.provider`,
    // a row written under a removed provider would drive the branch again.
    //
    // The row's provider IS read further down — but as a GUARD (§2.218.f2 M-2:
    // resume material may only be consumed when the row's own provider matches),
    // never as the input that selects the branch. Opposite directions: one would
    // let history choose behaviour, the other lets history only veto it.
    const assignment = resumeBlock.slice(0, resumeBlock.indexOf('\n'))
    expect(assignment).toContain('provider || getSettings().aiProvider')
    expect(assignment).not.toMatch(/session\??\.provider/)
  })

  // THE LOAD-BEARING ASSERTION. A dropped/unknown provider must fall out of
  // every branch. Written as `=== 'anthropic-api'`, an undefined provider skips
  // the claudeSessionId substitution; rewritten as `!== 'openai-api'`, it would
  // fall in and hand a legacy session's stored Claude id to a provider that was
  // never configured.
  it('gates the claudeSessionId substitution on positive equality with anthropic-api', () => {
    expect(resumeBlock).toContain("if (effectiveProvider === 'anthropic-api')")
    expect(resumeBlock).toContain('session?.claudeSessionId')
    expect(resumeBlock).not.toMatch(/effectiveProvider\s*!==/)
  })

  it('gates history loading on positive equality with the multi-turn providers', () => {
    expect(resumeBlock).toContain("effectiveProvider === 'openai-api'")
    expect(resumeBlock).toContain("effectiveProvider === 'gemini-api'")
  })

  // The E2E short-circuit returns before this block (mock stream), so no e2e
  // spec can observe the resume decision — which is exactly why it is pinned
  // here rather than left to the e2e suite.
  it('sits after the E2E short-circuit, so only this suite covers it', () => {
    const chatStart = MAIN_TS.indexOf("handleIpc('ai:chat'")
    const e2eReturn = MAIN_TS.indexOf('return { ok: true as const }', chatStart)
    const anchor = MAIN_TS.indexOf('const effectiveProvider = provider || getSettings().aiProvider', chatStart)
    expect(e2eReturn).toBeGreaterThan(-1)
    expect(anchor).toBeGreaterThan(e2eReturn)
  })
})

/**
 * §2.218.f2 (codex-security-review, M-1) — the `settings:save` handler must
 * REFUSE THE WHOLE PAYLOAD when a known renderer-writable field carries a value
 * the strict schema rejects and the §2.167 allowlist does not cover.
 *
 * The classifier decision itself is unit-tested in settingsSaveRefusal.test.ts.
 * What can only be checked here is the WIRING, and the wiring is the whole
 * point: the refusal has to happen BEFORE the merge and before anything reads
 * or writes the store, or the value it is refusing has already been applied.
 */
describe('§2.218.f2 main.ts — settings:save refuses unhandled schema failures before merging', () => {
  const saveStart = MAIN_TS.indexOf("handleIpc('settings:save'")
  const saveBody = MAIN_TS.slice(saveStart, MAIN_TS.indexOf('\n})', saveStart))

  it('destructures unhandledFields out of the partition call', () => {
    expect(saveStart).toBeGreaterThan(-1)
    expect(saveBody).toMatch(/const \{[^}]*unhandledFields[^}]*\} = partitionRendererSettingsIssues/)
  })

  it('throws on an unhandled field', () => {
    // Generous span: a long comment and the log call sit between the condition
    // and the throw. What is asserted is that the throw belongs to THIS guard —
    // no other `if` opens in between.
    const guardIdx = saveBody.indexOf('if (unhandledFields.length > 0')
    const throwIdx = saveBody.indexOf('throw rendererParsed.error')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(throwIdx).toBeGreaterThan(guardIdx)
    // Skip the guard's OWN opening line, then assert no further `if (` opens
    // between it and the throw — i.e. the throw is this guard's, not a nested
    // one's.
    const between = saveBody.slice(saveBody.indexOf('\n', guardIdx), throwIdx)
    expect(between).not.toMatch(/^\s*if \(/m)
  })

  // ORDER IS THE INVARIANT. A refusal that runs after the merge, after
  // `getSettings()` (which is not a pure read — it can migrate and WRITE the
  // store) or after `saveSettings` would be refusing something already applied.
  it('throws BEFORE the payload is stripped, merged, read against or written', () => {
    const throwIdx = saveBody.indexOf('throw rendererParsed.error')
    expect(throwIdx).toBeGreaterThan(-1)
    for (const later of [
      'const accepted = dropErasingUndefined',
      'let current = getSettings()',
      'const merged = applyAiDestinationDecision',
      'settingsSchema.parse(merged)',
    ]) {
      const idx = saveBody.indexOf(later)
      expect(idx, `expected "${later}" to come AFTER the refusal`).toBeGreaterThan(throwIdx)
    }
  })

  // …but AFTER the §3.10 P0 main-only gate, which owns its own audit row and
  // its own `forbidden_field` reason code. Swapping the two would answer a
  // boundary-crossing attempt with a generic throw and lose the audit trail.
  it('runs AFTER the main-only forbidden-field gate', () => {
    const gateIdx = saveBody.indexOf("return { ok: false as const, reason: 'forbidden_field' as const")
    const throwIdx = saveBody.indexOf('throw rendererParsed.error')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(throwIdx).toBeGreaterThan(gateIdx)
  })

  // The offending VALUE must not reach the log line — only field names, which
  // come from our own schema (CLAUDE.md §8).
  it('logs field names only, never the payload', () => {
    const logStart = saveBody.indexOf('logMain.warn(')
    // Bounded by the throw that follows it — the log call is the only statement
    // between the guard and the throw.
    const logCall = saveBody.slice(logStart, saveBody.indexOf('throw rendererParsed.error', logStart))
    expect(logStart).toBeGreaterThan(-1)
    // The only interpolation is the field-name list.
    const interpolations = logCall.match(/\$\{[^}]*\}/g) ?? []
    expect(interpolations).toEqual(["${unhandledFields.join(',')}"])
    // …and nothing derived from the payload is anywhere near it.
    expect(logCall).not.toMatch(/JSON\.stringify|rendererParsed|accepted|\bpayload\b/)
  })

  // The tempting wrong fix, pinned as wrong: adding the field to the §2.167
  // per-field refusal allowlist would have made the save PARTIAL — provider
  // silently cleared, everything else applied — which is the defect, not the fix.
  it('does not add aiProvider to the per-field refusal allowlist', () => {
    const refusalSrc = fs.readFileSync(path.join(__dirname, 'settingsSaveRefusal.ts'), 'utf8')
    const listStart = refusalSrc.indexOf('const REFUSABLE_FIELDS')
    const list = refusalSrc.slice(listStart, refusalSrc.indexOf(']', listStart))
    expect(listStart).toBeGreaterThan(-1)
    expect(list).not.toContain('aiProvider')
    expect(list).toContain('mcpExportWhitelist')
  })
})

/**
 * §2.218.f2 (codex-security-review, M-2) — resume material is provider-scoped.
 *
 * `claude_session_id` is minted by whichever provider created the row. The
 * removed `subscription` provider minted it against the user's CONSUMER Claude
 * session, so consuming it under `anthropic-api` would carry consumer-auth
 * material into an API-key request — reachable by an honest user reopening an
 * old chat, or by a compromised renderer passing an explicit provider override
 * for a session it did not create.
 */
describe('§2.218.f2 main.ts — resume material requires a provider match', () => {
  const resumeBlock = (() => {
    const chatStart = MAIN_TS.indexOf("handleIpc('ai:chat'")
    const anchor = MAIN_TS.indexOf("if (effectiveProvider === 'anthropic-api')", chatStart)
    return anchor > -1 ? MAIN_TS.slice(anchor, MAIN_TS.indexOf('\n  }', anchor)) : ''
  })()

  it('consumes claudeSessionId only when the row was created by the same provider', () => {
    expect(resumeBlock).not.toBe('')
    expect(resumeBlock).toMatch(
      /session\?\.claudeSessionId && session\.provider === effectiveProvider/,
    )
  })

  // The regression shape: a bare `if (session?.claudeSessionId)` guarding the
  // assignment, i.e. the pre-fix code.
  it('has no unguarded assignment of the stored resume id', () => {
    const assignIdx = resumeBlock.indexOf('effectiveSid = session.claudeSessionId')
    expect(assignIdx).toBeGreaterThan(-1)
    const guard = resumeBlock.slice(0, assignIdx)
    expect(guard).toContain('session.provider === effectiveProvider')
  })

  // A mismatch must fall through to a FRESH session, not to some other id.
  it('leaves effectiveSid alone on a mismatch', () => {
    const elseBranch = resumeBlock.slice(resumeBlock.indexOf('} else if'))
    expect(elseBranch).not.toContain('effectiveSid =')
  })

  it('compares the stored provider as an opaque string, not against the live enum', () => {
    // The row is HISTORY and may name a provider that no longer exists — that is
    // precisely the case being defended against, so it must not be validated
    // against `aiProviderSchema` (which would throw on it).
    expect(resumeBlock).not.toContain('aiProviderSchema')
  })
})
