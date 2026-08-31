/**
 * AI internet-tool interceptor (§3.10 P2).
 *
 * Closes the UX gap left by §3.10 P1's structural toolset filtering:
 * P1 removed `WebSearch` / `WebFetch` / external-MCP egress tools from the
 * model's available toolset whenever email content was in scope. The model
 * never even saw the tools, so it could not propose using them — but the
 * UX side-effect was a permanent red banner in the AI panel ("Internet
 * disabled while email content is in context") with no in-flow way for
 * the user to authorize a single specific egress operation.
 *
 * P2 keeps the same security invariants but moves the gate from
 * pre-flight tool filtering to runtime interception:
 *
 *   1. All internet tools are ALWAYS exposed to the LLM. The model can
 *      propose `WebSearch("foo")` / `WebFetch(url)` / `call_external_tool`
 *      whenever it judges them useful.
 *   2. Just before the tool actually executes, the gate intercepts the
 *      call and emits an `ai:internet-tool-pending` IPC event with a
 *      structured `{ requestId, toolName, query?, url? }` shape. The
 *      renderer surfaces an inline confirm UI in the AI panel.
 *   3. The interceptor `await`s the user's decision (approve / deny),
 *      with a 30-second timeout that auto-denies. No infinite-pending.
 *   4. On approve — the tool executes normally and the LLM gets the real
 *      result. On deny — the LLM gets `{ error: "User denied internet
 *      access for this tool call" }` and continues without the data.
 *   5. Per-turn consent: one approval covers EVERY internet-tool call
 *      in the same response. If the model fires five `WebSearch`es in a
 *      row, the user is asked once; subsequent calls in the same turn
 *      execute without re-prompting. State resets at the start of every
 *      new user turn.
 *   6. Per-turn denial: a single deny also persists for the rest of the
 *      turn — the model cannot keep retrying different URLs after the
 *      user said no once. The user can still grant consent on a fresh
 *      turn.
 *
 * Defence-in-depth (CLAUDE.md §5):
 *
 *   - The interceptor itself is the primary gate. Bypass requires a bug
 *     in the SDK callback wiring — both Claude Agent SDK's `canUseTool`
 *     hook and our in-process MCP tool handlers run synchronously before
 *     dispatch, so there is no async window.
 *   - The MCP tool handlers (`list_external_tools`, `call_external_tool`)
 *     ALSO consult `gate.consentForTurn` directly as a second-line check.
 *     If a future SDK regression reaches the handler without going
 *     through `canUseTool`, the handler still default-denies.
 *   - `wrapUntrusted()` is the responsibility of the renderer when
 *     rendering `query` / `url` (they come from the LLM, which is itself
 *     potentially driven by prompt-injected email content). The main
 *     side passes the raw strings through; the renderer must escape /
 *     wrap before injection into any HTML / template surface.
 *   - PII boundary: the audit log NEVER stores raw `query` or `url`.
 *     Both are SHA-256 hashed (first 8 bytes hex = 16 chars) before
 *     persistence. The query string itself can be an exfiltration vector
 *     (the LLM, possibly prompt-injected, could encode user data into the
 *     query) — so storing it would defeat the privacy guarantee we are
 *     trying to enforce.
 *   - 30-second consent timeout. Auto-deny at expiry. The pending
 *     promise resolves with `denied`, the LLM gets the same denial
 *     message it would get from an explicit user click. No infinite
 *     wait is possible.
 *
 * Hotspot policy: this module lives outside `electron/services/ai.ts`
 * (already 3000+ lines) so the security-critical interceptor surface is
 * isolated and easy to review.
 */

import { randomUUID, createHash } from 'node:crypto'
import { createLogger } from '../logger'
import { recordEvent } from '../metrics'
import { appendAiActionLog } from '../../packages/db'
import type { AiProvider } from './ai'

const log = createLogger('AI-InternetGate')

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * Tool names that the interceptor watches for. Matches the catalogue in
 * `aiEgressPolicy.EGRESS_TOOLS` plus the bare external-MCP names exposed
 * by the Vercel `@ai-sdk/mcp` client. A tool name is "internet" if it
 * matches any of:
 *   - `WebSearch`, `WebFetch` (Claude Agent SDK built-ins),
 *   - `mcp__mailcopilot__list_external_tools` / `..._call_external_tool`
 *     (Claude prefixed form),
 *   - `list_external_tools` / `call_external_tool` (Vercel bare form).
 */
const INTERNET_TOOL_NAMES = new Set<string>([
  'WebSearch',
  'WebFetch',
  'mcp__mailcopilot__list_external_tools',
  'mcp__mailcopilot__call_external_tool',
  'list_external_tools',
  'call_external_tool',
])

/** Returns true if the given tool name should be intercepted. */
export function isInternetTool(toolName: string): boolean {
  if (!toolName) return false
  return INTERNET_TOOL_NAMES.has(toolName)
}

// ---------------------------------------------------------------------------
// Consent state
// ---------------------------------------------------------------------------

/**
 * Three-state per-turn consent. `'unset'` means the user has not been
 * asked yet OR the previous turn just ended; `'approved'` allows every
 * subsequent internet-tool call in this turn to skip the prompt;
 * `'denied'` means the user said no once and every subsequent attempt
 * is also denied without re-prompting.
 */
export type TurnConsentState = 'unset' | 'approved' | 'denied'

/**
 * Who an intercepted egress decision is attributed to in the audit log.
 *
 * Either the AI provider running a chat turn, or `'mcp-export'` — the MCP
 * export server, which executes tool calls on behalf of an EXTERNAL client
 * (Claude Desktop et al.) and has no AI provider of its own.
 *
 * §2.218 — the export path used to borrow an AI provider id for this label,
 * defaulting to the (now removed) `subscription` value when the user had not
 * configured one. That was untrue in both directions: it attributed an
 * external client's egress to a provider that issued no request, and after the
 * removal it would have named a provider that no longer exists. Attribution is
 * a LABEL ONLY — no gate decision reads it — so the honest answer is a distinct
 * member rather than a borrowed one, and an unconfigured in-app AI provider
 * must not disable MCP export (external-client users routinely have none).
 */
export type EgressAttribution = AiProvider | 'mcp-export'

/**
 * Per-AI-request gate state. One instance per `aiChat()` invocation. The
 * lifetime is tied to the request (created in `aiChat()`, garbage-collected
 * when the request finishes). This is identical lifetime to `EgressGate`
 * from `aiEgressPolicy.ts`, and the two co-exist on the same request: the
 * `EgressGate` carries the policy snapshot for the legacy structural-filter
 * code paths, while the `InternetGate` here drives the new interactive
 * interceptor flow.
 */
export type InternetGate = {
  /** AI request id (matches `AiChatOptions.requestId`). */
  requestId: string
  /** Who this request is attributed to — recorded in the audit log. */
  provider: EgressAttribution
  /** Per-turn consent state. */
  consentForTurn: TurnConsentState
  /**
   * Pending request map: requestId-of-the-tool-call -> resolver. When
   * the renderer calls `ai:internet-tool-approve|deny` with a matching
   * `requestId`, the resolver fires.
   *
   * Multiple calls can be pending concurrently in pathological cases
   * (the model proposes parallel tool uses); each gets its own entry.
   * Per-turn consent dominates: once the first one is approved, the
   * remaining pendings auto-resolve as `approved` without prompting
   * the user a second time.
   */
  pending: Map<string, (decision: 'approved' | 'denied') => void>
}

/** Build a fresh per-request gate. */
export function createInternetGate(input: {
  requestId: string
  provider: EgressAttribution
}): InternetGate {
  return {
    requestId: input.requestId,
    provider: input.provider,
    consentForTurn: 'unset',
    pending: new Map(),
  }
}

/**
 * Reset per-turn consent at the boundary between turns. Called by
 * `aiChat()` in its `finally` block so that the next request starts
 * fresh, and on errors so a hung request cannot leak stale consent.
 *
 * Also rejects any still-pending consent prompts as `denied` — the
 * caller already finished, so the LLM is no longer waiting on a
 * decision; cleaning up the resolver maps prevents leaked timers.
 */
export function resetTurnConsent(gate: InternetGate): void {
  gate.consentForTurn = 'unset'
  for (const resolve of gate.pending.values()) {
    try { resolve('denied') } catch { /* swallow */ }
  }
  gate.pending.clear()
}

// ---------------------------------------------------------------------------
// Pending event broadcast — wired from main.ts
// ---------------------------------------------------------------------------

/**
 * Shape of the `ai:internet-tool-pending` IPC payload sent to the renderer.
 *
 * Untrusted content note: `query` and `url` come from the LLM, which can
 * itself be steered by prompt-injected email content. The renderer MUST
 * treat them as untrusted strings (escape HTML, no `dangerouslySetInnerHTML`,
 * no template-injection into i18n params without sanitisation). The main
 * process passes them through verbatim; sanitisation is the renderer's
 * responsibility because main has no DOM to escape against.
 */
export type InternetToolPendingEvent = {
  /**
   * Unique id for THIS specific consent prompt. The renderer echoes it
   * back via `ai:internet-tool-approve|deny` so the gate can resolve
   * the matching pending promise. Different from the AI request id.
   */
  requestId: string
  /** Internet tool the LLM is trying to invoke. */
  toolName: string
  /**
   * Normalised display fields. Exactly one of `query` / `url` is set
   * for the common cases (`WebSearch` -> `query`, `WebFetch` -> `url`);
   * for external MCP both may be absent and the renderer falls back to
   * a generic "AI wants to use external tool {name}" copy.
   */
  query?: string
  url?: string
  /** Raw arguments object — passed to the renderer for diagnostic
   *  expand-on-click views. May contain anything the LLM proposed. */
  args: unknown
}

type PendingBroadcaster = (payload: InternetToolPendingEvent) => void

let broadcaster: PendingBroadcaster | null = null

/**
 * Wire the renderer broadcast function. Called once from `electron/main.ts`
 * during startup. Kept as a setter (rather than an import dependency) so
 * this module stays pure-Node and trivially testable without booting the
 * Electron main process.
 */
export function setInternetToolPendingBroadcaster(fn: PendingBroadcaster | null): void {
  broadcaster = fn
}

// ---------------------------------------------------------------------------
// Pending registry — resolves on user response
// ---------------------------------------------------------------------------

/**
 * Per-process map of requestId -> gate. Allows the IPC handlers
 * (`ai:internet-tool-approve` / `ai:internet-tool-deny`) to find the
 * gate from outside the AI request scope. Entries removed when the AI
 * request finishes via `unregisterGate`.
 */
const gateRegistry = new Map<string, InternetGate>()

export function registerGate(gate: InternetGate): void {
  gateRegistry.set(gate.requestId, gate)
}

export function unregisterGate(gate: InternetGate): void {
  gateRegistry.delete(gate.requestId)
  resetTurnConsent(gate)
}

/**
 * Called by the IPC handler in main.ts when the renderer responds. The
 * `pendingId` is the per-prompt requestId (NOT the AI request id), so the
 * lookup walks every gate to find the matching entry. With at most a few
 * concurrent AI requests this is O(N*M) where both N and M are tiny;
 * keeping a flat global map keyed by pendingId would force two-step
 * cleanup on cancel paths which is more error-prone.
 */
export function resolveConsent(
  pendingId: string,
  decision: 'approved' | 'denied',
): boolean {
  for (const gate of gateRegistry.values()) {
    const resolve = gate.pending.get(pendingId)
    if (!resolve) continue
    gate.pending.delete(pendingId)
    // Promote the per-turn flag once the first decision lands. Subsequent
    // pending prompts (in the same turn) check `consentForTurn` and
    // auto-resolve without re-prompting the user.
    if (gate.consentForTurn === 'unset') {
      gate.consentForTurn = decision
    }
    try { resolve(decision) } catch { /* swallow */ }
    return true
  }
  log.warn(`resolveConsent: no pending entry for id=${pendingId} (decision=${decision})`)
  return false
}

// ---------------------------------------------------------------------------
// Interceptor — the public surface used by provider streamers
// ---------------------------------------------------------------------------

/** 30-second timeout. Configurable for tests via the override below. */
let consentTimeoutMs = 30_000

/** Test-only override. */
export function __setConsentTimeoutMs(ms: number): void {
  consentTimeoutMs = ms
}

/** Test-only: reset to default. */
export function __resetConsentTimeoutMs(): void {
  consentTimeoutMs = 30_000
}

/**
 * Decision returned by the interceptor.
 *
 * `'approved'` — caller may execute the tool normally.
 * `'denied'`   — caller MUST return an error result to the LLM. Do not
 *                 attempt to perform the underlying network operation.
 */
export type InterceptDecision = 'approved' | 'denied'

/**
 * Audit-safe normalisation of the LLM-supplied `query` / `url`. Returns
 * a SHA-256 truncated to 16 hex chars (8 bytes), low enough to keep the
 * audit row compact while retaining enough collision resistance to spot
 * obvious patterns ("five identical WebSearches in a row by the same
 * compromised session"). The raw string never touches disk.
 *
 * Empty / undefined / whitespace-only inputs collapse to an empty
 * string, NOT a hash, so the audit panel can distinguish "no query"
 * from "query was something but is hidden".
 */
function hashQueryOrUrl(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16)
}

/**
 * Extract the canonical display fields from the tool input. The two
 * hot tool families have well-known input shapes:
 *   - WebSearch:        `{ query: string, ... }`
 *   - WebFetch:         `{ url: string, ... }` (or `prompt: string` for
 *                        the agent variant, ignored here)
 *   - call_external_tool: `{ serverId, toolName, arguments?: {...} }`
 *
 * Anything else just returns no fields and the renderer falls back to
 * its generic copy. Type-narrows defensively because `args` is unknown.
 */
function pickDisplayFields(toolName: string, args: unknown): { query?: string; url?: string } {
  if (!args || typeof args !== 'object') return {}
  const obj = args as Record<string, unknown>
  if (toolName === 'WebSearch' || toolName.endsWith('list_external_tools')) {
    const q = obj.query
    if (typeof q === 'string') return { query: q }
    return {}
  }
  if (toolName === 'WebFetch') {
    const u = obj.url
    if (typeof u === 'string') return { url: u }
    return {}
  }
  if (toolName === 'call_external_tool' || toolName.endsWith('call_external_tool')) {
    // No URL exposed at this level — the actual remote call is mediated
    // by the external MCP server. Show the tool name as a "query" for
    // the renderer's display copy.
    const t = obj.toolName
    if (typeof t === 'string') return { query: t }
    return {}
  }
  return {}
}

/**
 * The interceptor entry point. Provider streamers and MCP tool handlers
 * call this just before they would have executed an internet tool; it
 * returns `'approved'` or `'denied'`. Side-effects:
 *   - Emits `ai.egress.intercepted` telemetry (PII-clean tags).
 *   - Persists one row to `ai_action_log` per call (PII-clean: hash
 *     only, no raw `query` / `url`).
 *   - Dispatches `ai:internet-tool-pending` IPC to the renderer when the
 *     gate has not yet recorded a per-turn decision.
 *
 * Per-turn consent dominates: if `gate.consentForTurn` is already
 * `'approved'` or `'denied'`, the function short-circuits without
 * prompting. The audit-log row still fires (with `was_consented_for_turn`
 * = true) so the privacy panel sees every individual attempt.
 */
export async function interceptInternetTool(args: {
  gate: InternetGate
  toolName: string
  toolInput: unknown
  /** Abort signal of the parent AI request. If aborted while pending,
   *  resolves as denied. */
  abortSignal?: AbortSignal
}): Promise<InterceptDecision> {
  const { gate, toolName, toolInput, abortSignal } = args

  // STEP 1: per-turn fast-path. If the user already decided this turn,
  // honour the decision without prompting again. Audit row + telemetry
  // still fire so the privacy panel sees every attempt.
  if (gate.consentForTurn === 'approved') {
    recordIntercepted({ toolName, outcome: 'approved', wasConsentedForTurn: true })
    appendAuditRow({ provider: gate.provider, toolName, toolInput, decision: 'approved', wasConsentedForTurn: true })
    return 'approved'
  }
  if (gate.consentForTurn === 'denied') {
    recordIntercepted({ toolName, outcome: 'denied', wasConsentedForTurn: true })
    appendAuditRow({ provider: gate.provider, toolName, toolInput, decision: 'denied', wasConsentedForTurn: true })
    log.info(`Internet tool ${toolName} auto-denied — user previously denied this turn`)
    return 'denied'
  }

  // STEP 2: prompt the renderer. If no broadcaster is wired (tests, or a
  // weird startup race), default-deny — never silently approve.
  if (!broadcaster) {
    log.warn(`Internet tool ${toolName} — no broadcaster wired, default-deny`)
    recordIntercepted({ toolName, outcome: 'denied', wasConsentedForTurn: false })
    appendAuditRow({ provider: gate.provider, toolName, toolInput, decision: 'denied', wasConsentedForTurn: false })
    return 'denied'
  }

  const pendingId = randomUUID()
  const display = pickDisplayFields(toolName, toolInput)
  const event: InternetToolPendingEvent = {
    requestId: pendingId,
    toolName,
    args: toolInput,
    ...(display.query ? { query: display.query } : {}),
    ...(display.url ? { url: display.url } : {}),
  }

  // STEP 3: race the user's decision against a 30s timeout and the
  // request's abort signal. Whichever fires first wins; the others get
  // cleaned up to avoid leaking timers / map entries.
  const decision = await new Promise<InterceptDecision>((resolve) => {
    let settled = false
    const settle = (d: InterceptDecision) => {
      if (settled) return
      settled = true
      gate.pending.delete(pendingId)
      clearTimeout(timer)
      if (abortSignal && abortListener) abortSignal.removeEventListener('abort', abortListener)
      resolve(d)
    }

    const timer = setTimeout(() => {
      log.warn(`Internet tool consent timed out after ${consentTimeoutMs}ms — auto-deny ${toolName}`)
      // Promote per-turn flag so subsequent calls don't all hit the same
      // 30s wait — once the user is unresponsive, every further call
      // this turn auto-denies immediately. The state is still cleared
      // on `resetTurnConsent` at request end.
      if (gate.consentForTurn === 'unset') gate.consentForTurn = 'denied'
      settle('denied')
    }, consentTimeoutMs)

    let abortListener: (() => void) | null = null
    if (abortSignal) {
      if (abortSignal.aborted) {
        settle('denied')
        return
      }
      abortListener = () => {
        log.info(`Internet tool consent aborted — request cancelled (${toolName})`)
        settle('denied')
      }
      abortSignal.addEventListener('abort', abortListener, { once: true })
    }

    gate.pending.set(pendingId, settle)
    try {
      broadcaster!(event)
    } catch (err) {
      log.error(`Failed to broadcast ai:internet-tool-pending: ${err instanceof Error ? err.message : String(err)}`)
      // Broadcaster failure -> the renderer will never respond -> the
      // 30s timeout would auto-deny anyway. Skip the wait and deny
      // immediately so the LLM gets feedback faster.
      settle('denied')
    }
  })

  // STEP 4: audit + telemetry. Both fire regardless of outcome.
  recordIntercepted({ toolName, outcome: decision, wasConsentedForTurn: false })
  appendAuditRow({ provider: gate.provider, toolName, toolInput, decision, wasConsentedForTurn: false })
  return decision
}

/**
 * Standard error result the LLM sees on a denied internet-tool call.
 * Shape mirrors the existing `egressBlockedResponse` for consistency
 * across the two gates.
 */
export function deniedToolResult(toolName: string): {
  blocked: true
  reason: 'internet_tool_denied'
  message: string
} {
  return {
    blocked: true,
    reason: 'internet_tool_denied',
    message: `User denied internet access for this tool call (${toolName}). ` +
      `Do not retry this turn — the user has been informed and can grant access in the AI panel if needed. ` +
      `Continue without external data, or tell the user you cannot complete the request without internet access.`,
  }
}

// ---------------------------------------------------------------------------
// Telemetry + audit
// ---------------------------------------------------------------------------

/** Low-cardinality tag normalisation — same enumeration as
 *  `aiEgressPolicy.normaliseEgressToolTag`. */
const KNOWN_INTERCEPT_TOOL_TAGS = new Set<string>([
  'WebSearch',
  'WebFetch',
  'mcp__mailcopilot__list_external_tools',
  'mcp__mailcopilot__call_external_tool',
  'list_external_tools',
  'call_external_tool',
])

function normaliseToolTag(toolName: string): string {
  if (KNOWN_INTERCEPT_TOOL_TAGS.has(toolName)) return toolName
  return 'other'
}

function recordIntercepted(input: {
  toolName: string
  outcome: 'approved' | 'denied'
  wasConsentedForTurn: boolean
}): void {
  try {
    recordEvent('ai.egress.intercepted', {
      tool_name: normaliseToolTag(input.toolName),
      outcome: input.outcome,
      was_consented_for_turn: input.wasConsentedForTurn,
    })
  } catch {
    /* telemetry must never throw */
  }
}

/**
 * Append one privacy-audit row per intercept attempt. The audit log is the
 * append-only B1 trust surface — same shape used by `aiChat()` for the
 * per-request summary row, but `goal` distinguishes interceptor entries
 * so the privacy panel can render them as a discrete category.
 *
 * PII boundary:
 *   - `tool_name` — low-cardinality enum (`WebSearch`, `WebFetch`,
 *     external MCP names). Does NOT carry user content.
 *   - The actual `query` / `url` are SHA-256 hashed (16 hex chars) and
 *     stuffed into the `goal` column as `intercept:<outcome>:<hash>`.
 *     Storing the raw string would directly defeat the privacy
 *     guarantee — any prompt-injected exfiltration attempt encodes
 *     stolen data into the very query string we'd otherwise persist.
 */
function appendAuditRow(input: {
  provider: EgressAttribution
  toolName: string
  toolInput: unknown
  decision: 'approved' | 'denied'
  wasConsentedForTurn: boolean
}): void {
  try {
    const display = pickDisplayFields(input.toolName, input.toolInput)
    const hash = hashQueryOrUrl(display.query ?? display.url ?? '')
    const tag = input.wasConsentedForTurn ? 'turn-consent' : 'prompt'
    const goal = `egress_intercept:${input.decision}:${tag}${hash ? `:${hash}` : ''}`
    appendAiActionLog({
      provider: input.provider,
      model: null,
      goal,
      toolName: input.toolName,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      untrustedWrapped: 0,
      // §3.10 P2: a denied intercept is the closest analogue to an
      // injection-blocked event we have — surface it through the same
      // counter so the existing privacy panel "blocked" column
      // increments without a schema change.
      injectionBlocked: input.decision === 'denied' ? 1 : 0,
      outcome: 'ok',
    })
  } catch {
    /* audit append must never throw */
  }
}
