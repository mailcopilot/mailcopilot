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
 *   2. The CONTINUATION path cannot be steered by a legacy row. The branch that
 *      loads conversation history is a positive equality list against live
 *      providers, so an unknown or dropped provider falls out of it rather than
 *      into it. (§2.283 removed the second branch, which used to substitute a
 *      stored Claude CLI session id for `resume`; see the dedicated suites at
 *      the bottom of this file.)
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

describe('§2.218 main.ts — a legacy session cannot steer the continuation path', () => {
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
    // §2.283 — the session row is no longer read on this path at all: the guard
    // that compared its provider before consuming resume material went with the
    // resume mechanism itself.
    const assignment = resumeBlock.slice(0, resumeBlock.indexOf('\n'))
    expect(assignment).toContain('provider || getSettings().aiProvider')
    expect(assignment).not.toMatch(/session\??\.provider/)
  })

  // THE LOAD-BEARING ASSERTION. A dropped/unknown provider must fall out of the
  // branch. Written as positive equalities, an undefined provider loads no
  // history and the turn fails cleanly with "AI provider not configured";
  // rewritten as `!== 'openai-api'`, it would fall IN.
  it('gates history loading on positive equality, never on a negative', () => {
    expect(resumeBlock).not.toMatch(/effectiveProvider\s*!==/)
  })

  it('gates history loading on positive equality with every live provider', () => {
    expect(resumeBlock).toContain("effectiveProvider === 'anthropic-api'")
    expect(resumeBlock).toContain("effectiveProvider === 'openai-api'")
    expect(resumeBlock).toContain("effectiveProvider === 'gemini-api'")
  })

  // The E2E short-circuit returns before this block (mock stream), so no e2e
  // spec can observe the history decision — which is exactly why it is pinned
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
      // The persisted parse. §1.26.f2 renamed its ARGUMENT (the merged object
      // now passes through the account-keyed consent scoping first); the marker
      // follows the call, because what this asserts is the order of the parse,
      // not the name of the value handed to it.
      'settingsSchema.parse(consentScope.settings)',
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
 * §2.283 — Anthropic lost its own continuation mechanism, so it MUST take the
 * shared one.
 *
 * The Claude provider used to run through the proprietary Agent SDK, which kept
 * the conversation inside the Claude Code CLI and rejoined it via the stored
 * `claude_session_id` (`resume`). That is why `anthropic-api` was absent from
 * the history-loading list. Moving the provider onto the shared `streamText`
 * path removed `resume` — and left the absence behind, which silently collapsed
 * every multi-turn Claude conversation into a single-turn one: the model saw
 * only the latest prompt.
 *
 * The condition is EVALUATED here, not merely pattern-matched, so the test
 * states the behaviour ("Claude loads history, a removed provider does not")
 * rather than the spelling of the branch.
 */
describe('§2.283 main.ts — history loads for every live provider, Claude included', () => {
  /** The `if (...)` condition that guards the `getLastAiMessages` call. */
  const historyCondition = (() => {
    const chatStart = MAIN_TS.indexOf("handleIpc('ai:chat'")
    const anchor = MAIN_TS.indexOf('const effectiveProvider = provider || getSettings().aiProvider', chatStart)
    if (anchor < 0) return null
    const loadIdx = MAIN_TS.indexOf('getLastAiMessages(sid, 40)', anchor)
    if (loadIdx < 0) return null
    const ifIdx = MAIN_TS.lastIndexOf('if (', loadIdx)
    const openIdx = MAIN_TS.indexOf('(', ifIdx)
    const closeIdx = MAIN_TS.indexOf(') {', openIdx)
    return ifIdx > anchor && closeIdx > openIdx ? MAIN_TS.slice(openIdx + 1, closeIdx) : null
  })()

  /** Evaluate the extracted condition for one value of `effectiveProvider`. */
  function loadsHistoryFor(effectiveProvider: string | undefined): boolean {
    expect(historyCondition).not.toBeNull()
    const evaluate = new Function('effectiveProvider', `return Boolean(${historyCondition})`) as (
      p: string | undefined,
    ) => boolean
    return evaluate(effectiveProvider)
  }

  // THE REGRESSION. Fails against the pre-fix source, where the list was
  // `openai-api || gemini-api` and Claude fell out of it.
  it('loads history for anthropic-api', () => {
    expect(loadsHistoryFor('anthropic-api')).toBe(true)
  })

  it.each(['openai-api', 'gemini-api'])('still loads history for %s', (p) => {
    expect(loadsHistoryFor(p)).toBe(true)
  })

  // The §2.218 property, restated as behaviour: an unknown or removed provider
  // falls OUT of the list. `subscription` is the concrete case — such a session
  // must not be continued under a provider that no longer exists.
  it.each(['subscription', 'not-a-provider', ''])('does not load history for %s', (p) => {
    expect(loadsHistoryFor(p)).toBe(false)
  })

  it('does not load history when no provider is configured', () => {
    expect(loadsHistoryFor(undefined)).toBe(false)
  })
})

/**
 * §2.283 — the resume path is GONE, not merely unused.
 *
 * With the Agent SDK removed there is no `resume`, and `event.sessionId` is an
 * echo of the id main just passed in. The provider-scoped gate of §2.218.f2
 * (a legacy `subscription` row must not hand its CONSUMER-minted Claude id to
 * an `anthropic-api` request) is satisfied structurally instead: no stored id
 * is substituted into the request at all, and main writes nothing back. The
 * `claude_session_id` COLUMN stays — it is history, and dropping it is a schema
 * migration, not part of this fix.
 */
describe('§2.283 main.ts — nothing substitutes or mints resume material', () => {
  const chatBody = (() => {
    const start = MAIN_TS.indexOf("handleIpc('ai:chat'")
    return MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
  })()

  it('passes the app-level session id straight to aiChat', () => {
    expect(chatBody).toContain('sessionId: sid,')
    expect(chatBody).not.toContain('effectiveSid')
  })

  it('never reads the stored resume id on the chat path', () => {
    expect(chatBody).not.toContain('claudeSessionId')
  })

  // Writing `event.sessionId` back stored OUR OWN id under a column that means
  // "the CLI's session". The writer is gone from main entirely — asserted on the
  // whole file, because an import kept alive is how such a call comes back.
  it('does not write claude_session_id from anywhere in main', () => {
    expect(MAIN_TS).not.toContain('updateAiSessionClaudeId')
  })
})

/**
 * §2.283.f1 (codex, Low) — ONE settings read, two uses.
 *
 * The history decision above resolves `provider || getSettings().aiProvider`.
 * `aiChat` performs the SAME fallback internally when the request carries no
 * explicit provider, so handing it the raw `provider` (usually `undefined`)
 * made this a two-read decision with a window between the reads. The renderer
 * may save settings while a chat request is in flight, and a provider switch
 * landing in that window would load one provider's history and run the turn on
 * another — or, for a switch INTO `anthropic-api`, load no history at all
 * before a turn that needs it (the §2.283 regression, re-opened by a race).
 *
 * The fix is to resolve once and pass that value on. What is asserted here is
 * exactly that link: the identifier the positive history gate tests is the same
 * identifier `aiChat` receives, and settings are read once on this path. Both
 * are DERIVED from the source (identifier names are parsed out, not spelled in
 * the test), so the suite states the property rather than the wording.
 */
describe('§2.283.f1 main.ts — the provider is resolved once and reused', () => {
  const chatBody = (() => {
    const start = MAIN_TS.indexOf("handleIpc('ai:chat'")
    return MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
  })()

  /** The `if (...)` condition guarding the `getLastAiMessages` call. */
  const historyCondition = (() => {
    const loadIdx = chatBody.indexOf('getLastAiMessages(sid, 40)')
    if (loadIdx < 0) return null
    const ifIdx = chatBody.lastIndexOf('if (', loadIdx)
    const openIdx = chatBody.indexOf('(', ifIdx)
    const closeIdx = chatBody.indexOf(') {', openIdx)
    return ifIdx > -1 && closeIdx > openIdx ? chatBody.slice(openIdx + 1, closeIdx) : null
  })()

  /** Identifiers compared with `===` inside the history gate. */
  const gatedIdentifiers = (() => {
    const names = new Set<string>()
    for (const m of (historyCondition ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*===/g)) names.add(m[1])
    return [...names]
  })()

  /** The expression passed as `aiProvider:` in the `aiChat({ ... })` call. */
  const aiChatProviderArg = (() => {
    const callIdx = chatBody.indexOf('aiChat({')
    if (callIdx < 0) return null
    const m = chatBody.slice(callIdx).match(/aiProvider:\s*([^,}]+)/)
    return m ? m[1].trim() : null
  })()

  it('gates history on exactly one resolved provider value', () => {
    expect(historyCondition).not.toBeNull()
    expect(gatedIdentifiers).toHaveLength(1)
  })

  // THE FIX, stated as a link rather than as text: whatever the gate tests is
  // what the turn runs on. Fails against the pre-fix source, which passed the
  // raw per-request `provider` and let `aiChat` re-read settings.
  it('hands that same value to aiChat explicitly', () => {
    expect(aiChatProviderArg).not.toBeNull()
    expect(aiChatProviderArg).toBe(gatedIdentifiers[0])
  })

  // The resolution must sit ABOVE the history block, so a single evaluation
  // serves both uses; declaring it inside `if (sid)` is how the second read
  // (inside aiChat) became necessary in the first place.
  it('resolves the provider before the history block, not inside it', () => {
    const declIdx = chatBody.indexOf(`const ${gatedIdentifiers[0]} =`)
    const sidIdx = chatBody.indexOf('if (sid) {')
    expect(declIdx).toBeGreaterThan(-1)
    expect(sidIdx).toBeGreaterThan(declIdx)
  })

  // Comments are stripped first: the block above deliberately NAMES the
  // fallback it is removing, and a prose mention is not a read.
  it('reads the settings provider exactly once on the chat path', () => {
    const code = chatBody.replace(/^\s*\/\/.*$/gm, '')
    expect(code.match(/getSettings\(\)\.aiProvider/g) ?? []).toHaveLength(1)
  })
})
