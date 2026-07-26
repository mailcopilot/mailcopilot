/**
 * §3.10 P1 — coverage gaps follow-up (test-gen audit, 2026-04-24).
 *
 * The primary coverage in `aiEgressPolicy.test.ts` and
 * `aiEgressInjection.test.ts` proves the gate's structural correctness.
 * This file fills six smaller gaps the audit surfaced — none of them
 * exercise new behaviour, they pin invariants that are easy to break
 * silently when the policy or the tool catalogue evolves.
 *
 *   1. Combined consent + taint + email-context (all three at once).
 *   2. EMAIL_DATA_TOOLS catalogue completeness vs the read-only slice
 *      of `ALLOWED_TOOLS` in `ai.ts`. A test-only synthetic enumeration
 *      is used because importing `ai.ts` here boots the entire AI
 *      service surface and inflates the suite by a couple of seconds
 *      per file load.
 *   3. Settings persistence: missing/legacy `aiEgressPolicy` round-trips
 *      to `'default-deny'` via the zod schema default.
 *   4. Per-provider gate-primitive consistency: a single gate state is
 *      observed identically by `computeBuiltinTools`, `computeAllowedTools`,
 *      and `filterVercelTools` (Claude / OpenAI-AI-SDK / Gemini parity).
 *   5. Stable taint after a tainting tool is followed by an unrelated tool.
 *   6. Fresh-gate isolation: one request's taint doesn't leak into the next.
 *
 * Strategy: keep this file pure-function only. No vitest-mocking ceremony,
 * no electron, no DB. The goal is delta-coverage, not re-running the
 * primary suite from another angle.
 */

import { describe, it, expect, vi } from 'vitest'

// Importing `../../packages/net/config` transitively pulls in
// `packages/db` (better-sqlite3 native binding) and electron-store. Mock
// the heavy bits the same way `packages/net/config.test.ts` does.
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(() => Promise.resolve(null)),
    setPassword: vi.fn(() => Promise.resolve()),
    deletePassword: vi.fn(() => Promise.resolve(true)),
  },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    get() { return undefined }
    set() {}
    delete() {}
  },
}))
vi.mock('../../packages/db', () => ({
  deleteAccountData: vi.fn(),
}))

import {
  EMAIL_DATA_TOOLS,
  EGRESS_TOOLS,
  computeAllowedTools,
  computeBuiltinTools,
  filterVercelTools,
  createEgressGate,
  markEmailDataAccessed,
  shouldDenyEgress,
  coerceEgressPolicy,
  defaultEgressPolicy,
} from './aiEgressPolicy'
import type { EmailContext } from './ai'
import { rendererWritableSettingsSchema, settingsSchema } from '../../packages/net/config'

// Vitest's recordEvent mock is not needed here — we only call pure code.

// ---------------------------------------------------------------------------
// Gap 1: combined consent + taint + email-context
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / consent overrides every deny vector', () => {
  it('consent unlocks egress when ALL three deny inputs fire (context + taint + default-deny policy)', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: true,
    })
    // Even after taint propagation on top of an already-tainting context,
    // consent still wins. Without this regression, a future refactor
    // could reorder the checks in `shouldDenyEgress` and silently make
    // taint-after-context override consent.
    markEmailDataAccessed(gate, 'mcp__mailcopilot__search_emails')
    expect(gate.taintedByToolUse).toBe(true)
    expect(gate.initialEmailContext).toBe(true)
    expect(shouldDenyEgress(gate)).toBe(false)

    // And the SDK primitives respect that.
    const baseAllowed = [...EGRESS_TOOLS, 'mcp__mailcopilot__get_email']
    expect(computeAllowedTools(baseAllowed, gate)).toEqual(baseAllowed)
    expect(computeBuiltinTools(gate)).toEqual(['WebSearch', 'WebFetch'])
  })
})

// ---------------------------------------------------------------------------
// Gap 2: EMAIL_DATA_TOOLS catalogue completeness
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / EMAIL_DATA_TOOLS catalogue', () => {
  /**
   * Read-only slice of `ALLOWED_TOOLS` from `electron/services/ai.ts`. Kept
   * inline (and asserted against the production list manually) because
   * importing `ai.ts` here would boot the whole AI service surface in a
   * vitest worker. If you add a new read-side MCP tool, add it here AND in
   * `EMAIL_DATA_TOOLS`. The test below pins the diff so the omission can't
   * land silently.
   */
  const READ_ONLY_TOOL_SLICE = [
    'get_email',
    'list_emails',
    'search_emails',
    'list_folders',
    'get_thread',
    'get_contacts',
    'get_current_context',
    'get_account_info',
    'count_unread',
    'query_db',
    'list_attachments',
    'read_attachment',
    'get_attachment_hash',
    'list_mail_rules',
    'get_rule_log',
  ] as const

  /**
   * Tools that are read-only at the MCP layer but the policy author has
   * elected NOT to treat as taint-tripping. Each entry MUST come with a
   * justification — the gate becomes weaker every time something is moved
   * here. If this list grows without a security review, the regression is
   * the gap, not the test.
   *
   * Wave 2 (codex-security-review MEDIUM #1, 2026-04-24): the previous
   * entries `get_account_info` and `count_unread` were promoted into
   * `EMAIL_DATA_TOOLS`. Both expose user-derived data that can be
   * exfiltrated via a query-string side channel; gating them as
   * email-data tools makes the taint signal complete and matches the
   * test-gen audit cross-validation. The list is intentionally empty —
   * any new omission must come with a fresh justification block.
   */
  const KNOWN_OMISSIONS: readonly string[] = []

  it('every read-only tool is either tainting or explicitly justified', () => {
    const missing: string[] = []
    for (const name of READ_ONLY_TOOL_SLICE) {
      if (!EMAIL_DATA_TOOLS.has(name) && !KNOWN_OMISSIONS.includes(name)) {
        missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })

  it('KNOWN_OMISSIONS only lists tools that exist in the read-only slice', () => {
    // Defensive: prevents a stale omission entry from masking a real new
    // tool that happens to share the same name.
    for (const name of KNOWN_OMISSIONS) {
      expect(READ_ONLY_TOOL_SLICE).toContain(name)
    }
  })

  it('EMAIL_DATA_TOOLS contains nothing outside the documented read-only slice', () => {
    // Catches the inverse mistake — adding a mutating or invalid tool
    // name to the taint set, where it would never fire.
    for (const name of EMAIL_DATA_TOOLS) {
      expect(READ_ONLY_TOOL_SLICE).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 3: Settings persistence — default applied when missing/legacy
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / settings persistence default', () => {
  // settingsSchema requires `theme` + `cacheDays` as required fields; we
  // pass them throughout to isolate the aiEgressPolicy assertion from
  // other validation noise.
  const BASE_SETTINGS = { theme: 'light', cacheDays: 30 } as const

  it('full settings schema fills in default-deny when aiEgressPolicy missing (legacy install)', () => {
    // Simulate a settings.json saved before §3.10 P1 landed: no
    // aiEgressPolicy field at all. The read-side schema must coerce to
    // 'default-deny' so the gate is closed at first read after upgrade.
    const parsed = settingsSchema.parse({ ...BASE_SETTINGS })
    expect(parsed.aiEgressPolicy).toBe('default-deny')
  })

  it('full settings schema preserves user-set policy across re-parse (round-trip)', () => {
    for (const value of ['default-deny', 'ask', 'allow'] as const) {
      const parsed = settingsSchema.parse({ ...BASE_SETTINGS, aiEgressPolicy: value })
      expect(parsed.aiEgressPolicy).toBe(value)
      // Re-parse simulates restart-and-reload of settings.json.
      const reparsed = settingsSchema.parse({ ...BASE_SETTINGS, aiEgressPolicy: parsed.aiEgressPolicy })
      expect(reparsed.aiEgressPolicy).toBe(value)
    }
  })

  it('renderer-writable schema accepts known values and rejects unknown ones', () => {
    // Pinned here as well as in config.test.ts so the policy-level
    // contract is visible in one place alongside the gate logic.
    expect(rendererWritableSettingsSchema.safeParse({ aiEgressPolicy: 'allow' }).success).toBe(true)
    expect(rendererWritableSettingsSchema.safeParse({ aiEgressPolicy: 'block' }).success).toBe(false)
  })

  it('coerceEgressPolicy maps unparseable settings input to default-deny', () => {
    // Defends in-depth: even if a settings.json on disk has a manually
    // edited bogus value that bypasses zod somehow, the gate code still
    // collapses it to deny instead of failing open.
    expect(coerceEgressPolicy(undefined)).toBe(defaultEgressPolicy())
    expect(coerceEgressPolicy('legacy-mode-off')).toBe('default-deny')
    expect(coerceEgressPolicy({ malicious: true })).toBe('default-deny')
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Provider-path consistency
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / cross-provider consistency', () => {
  // The full ALLOWED_TOOLS list, with both built-in tools and external MCP
  // bridge tools, mirrored from ai.ts. Provider parity is asserted at the
  // primitive level; the actual SDK invocation is covered by ai.test.ts.
  const FULL_ALLOWED = [
    'mcp__mailcopilot__get_email',
    'mcp__mailcopilot__search_emails',
    'mcp__mailcopilot__apply_mail_action',
    'mcp__mailcopilot__list_external_tools',
    'mcp__mailcopilot__call_external_tool',
    'WebSearch',
    'WebFetch',
  ]
  const VERCEL_TOOLS_MAP = Object.fromEntries(
    FULL_ALLOWED.map((name) => [name, { description: name }]),
  )

  it('a single denied gate produces consistent egress filtering across all three SDK paths', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(true)

    // Claude path: builtins + allowedTools.
    expect(computeBuiltinTools(gate)).toEqual([])
    const claudeAllowed = computeAllowedTools(FULL_ALLOWED, gate)
    for (const eg of EGRESS_TOOLS) expect(claudeAllowed).not.toContain(eg)

    // Vercel AI SDK path (OpenAI / Gemini): tools map.
    const filtered = filterVercelTools(VERCEL_TOOLS_MAP, gate)
    for (const eg of EGRESS_TOOLS) expect(filtered).not.toHaveProperty(eg)

    // The non-egress surface is identical across all three paths — the
    // model still sees mailcopilot read-only and apply tools.
    expect(claudeAllowed).toContain('mcp__mailcopilot__get_email')
    expect(claudeAllowed).toContain('mcp__mailcopilot__apply_mail_action')
    expect(filtered).toHaveProperty('mcp__mailcopilot__get_email')
    expect(filtered).toHaveProperty('mcp__mailcopilot__apply_mail_action')
  })

  it('a single allowed gate produces consistent egress passthrough across all three SDK paths', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: true, // consent unlocks all three paths the same way
    })
    expect(shouldDenyEgress(gate)).toBe(false)
    expect(computeBuiltinTools(gate)).toEqual(['WebSearch', 'WebFetch'])
    expect(computeAllowedTools(FULL_ALLOWED, gate)).toEqual(FULL_ALLOWED)
    // Vercel passthrough returns the SAME object reference (perf
    // optimisation in filterVercelTools); we only assert structural
    // equality here so a future refactor that copies under allow can't
    // silently break the assertion.
    const filtered = filterVercelTools(VERCEL_TOOLS_MAP, gate)
    for (const name of FULL_ALLOWED) expect(filtered).toHaveProperty(name)
  })

  /**
   * Wave 3 BLOCKER fix (codex-security-review, 2026-04-24).
   *
   * The Vercel `@ai-sdk/mcp` client keys mailcopilot tools by their bare
   * MCP name (`list_external_tools`), not the Claude-side prefixed form
   * (`mcp__mailcopilot__list_external_tools`). The original cross-provider
   * test above only exercised the prefixed shape, so a regression in
   * `filterVercelTools` that left bare-name keys intact would not have
   * been caught here. This case mirrors the realistic OpenAI / Gemini
   * `mcpClient.tools()` map shape and pins the structural-removal AC.
   */
  it('Vercel-side bare-keyed tools are stripped under denial parity (wave 3 regression)', () => {
    const VERCEL_REALISTIC_BARE_MAP = {
      get_email: { description: 'bare get_email' },
      search_emails: { description: 'bare search_emails' },
      apply_mail_action: { description: 'bare apply_mail_action' },
      list_external_tools: { description: 'bare list_external_tools' },
      call_external_tool: { description: 'bare call_external_tool' },
    }
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(true)
    const filtered = filterVercelTools(VERCEL_REALISTIC_BARE_MAP, gate)
    expect(filtered).not.toHaveProperty('list_external_tools')
    expect(filtered).not.toHaveProperty('call_external_tool')
    expect(filtered).toHaveProperty('get_email')
    expect(filtered).toHaveProperty('search_emails')
    expect(filtered).toHaveProperty('apply_mail_action')
  })
})

// ---------------------------------------------------------------------------
// Gap 5: Taint stability across mixed tool calls
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / taint stability', () => {
  it('once tainted, an unrelated mutating tool call does not clear the taint', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    markEmailDataAccessed(gate, 'mcp__mailcopilot__search_emails')
    expect(gate.taintedByToolUse).toBe(true)

    // A subsequent mutating tool isn't an email-data tool — but it must
    // not flip the taint back to false either. (`markEmailDataAccessed`
    // is monotonic by design; this test pins that property.)
    markEmailDataAccessed(gate, 'mcp__mailcopilot__apply_mail_action')
    markEmailDataAccessed(gate, 'WebSearch')
    expect(gate.taintedByToolUse).toBe(true)
    expect(shouldDenyEgress(gate)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Fresh-gate isolation between requests
// ---------------------------------------------------------------------------

describe('aiEgressPolicy / per-request gate isolation', () => {
  it('a new gate built for the next request does not inherit prior taint', () => {
    // Request 1: taint propagates after a search_emails.
    const gate1 = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    markEmailDataAccessed(gate1, 'mcp__mailcopilot__get_email')
    expect(gate1.taintedByToolUse).toBe(true)

    // Request 2: clean prompt, no context. The new gate must start
    // pristine — no global taint state, no leak through module-level
    // singletons. This is the structural property that makes consent
    // "per-turn" instead of "permanent allow".
    //
    // Wave 2 (2026-04-24): the new gate denies by default — that's the
    // wave 2 contract. Both requests share the deny outcome, but the
    // taint flag remains per-request as a separate observability signal.
    const gate2 = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    expect(gate2.taintedByToolUse).toBe(false)
    expect(shouldDenyEgress(gate2)).toBe(true)
  })

  it('two concurrent requests with different contexts never alias their taint state', () => {
    const gateA = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const gateB = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    markEmailDataAccessed(gateA, 'mcp__mailcopilot__search_emails')
    expect(gateA.taintedByToolUse).toBe(true)
    expect(gateB.taintedByToolUse).toBe(false)
    // Wave 2 (2026-04-24): both gates deny. The point of the test is that
    // taint state is per-gate (no aliasing); the deny outcome is now
    // policy-driven rather than taint-driven, but the isolation invariant
    // still holds for the bookkeeping flag.
    expect(shouldDenyEgress(gateB)).toBe(true)
  })

  it('wave 2 — cross-turn multi-turn vector: prior turn email data cannot exfiltrate via current-turn WebFetch', () => {
    // Codex HIGH #1 (2026-04-24): prior-turn email content persists in
    // the model's chat history; without taint persistence across `aiChat`
    // calls, turn N+1 with no current EmailContext could expose WebFetch
    // and let the model exfiltrate via the prior-turn content.
    //
    // Wave 2 fix transitively closes this: each new aiChat() call builds
    // a fresh gate. Under default-deny without per-request consent, that
    // gate denies — there is no need to remember prior-turn taint, because
    // tools[] is locked closed regardless. Per-request consent does not
    // persist (the renderer resets the consent flag after each turn), so
    // turn N+1 starts fresh in the deny state.
    const turn1 = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: true, // user gave consent for turn 1 only
    })
    expect(shouldDenyEgress(turn1)).toBe(false)

    // Turn 2: no current EmailContext (user closed the email pane), no
    // consent renewed. The gate denies — egress tools never enter the
    // SDK config for turn 2, so the model cannot exfiltrate prior-turn
    // content even though that content remains in the chat history.
    const turn2 = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(turn2)).toBe(true)
  })
})
