/**
 * MCP Export Server — exposes MailCopilot MCP tools to external clients
 * via Streamable HTTP transport on localhost.
 *
 * External MCP clients (Claude Code, Obsidian, other agents) can connect
 * to http://localhost:<port>/mcp and use the whitelisted mail tools.
 *
 * Security: bearer token authentication is required for all requests.
 * A random token is generated on each server start and must be passed
 * via the Authorization header (Bearer <token>). CORS is restricted to
 * localhost origins only to prevent browser-based CSRF from remote sites.
 *
 * §2.158 — two further limits on what a connected client can reach:
 *   - the requested whitelist is INTERSECTED with `ALL_EXPORTABLE_TOOLS`
 *     (`resolveExportWhitelist`), so no settings value can register a tool
 *     outside the declared ceiling;
 *   - every session gets the same egress / internet gates the chat path
 *     builds (`buildExportGates`), so an external client cannot use the
 *     external-MCP bridge under a policy that forbids the chat path from
 *     using it.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMailMcpServer } from './ai'
import {
  EXPORTABLE_MCP_TOOLS,
  getSettings,
  isExportableMcpTool,
  type ExportableMcpTool,
} from '../../packages/net/config'
import {
  coerceEgressPolicy,
  createEgressGate,
  shouldDenyEgress,
  type EgressGate,
} from './aiEgressPolicy'
import { createInternetGate, type InternetGate } from './aiInternetGate'
import { createLogger } from '../logger'

const log = createLogger('McpExport')

/** Origins allowed for CORS — only localhost variants */
const ALLOWED_ORIGINS = new Set([
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://[::1]',
  'https://[::1]',
])

/**
 * Default read-only tools exposed to external clients.
 *
 * Typed as `ExportableMcpTool[]`, not `string[]`: a name that is not in the
 * ceiling must fail to COMPILE here rather than be caught at runtime. The
 * runtime intersection below still runs on this list (one enforcement point,
 * no "trusted" branch), but a type error is the cheaper of the two signals.
 */
export const DEFAULT_EXPORT_WHITELIST: readonly ExportableMcpTool[] = [
  'get_email', 'list_emails', 'search_emails',
  'list_folders', 'get_thread', 'get_contacts',
  'get_account_info', 'count_unread', 'query_db',
  'list_attachments', 'read_attachment', 'get_attachment_hash',
]

/**
 * All tool names that can be exported — the CEILING of the export surface.
 *
 * §2.158: this was a decorative declaration until now (zero production
 * references; only the test file imported it), so any string in
 * `Settings.mcpExportWhitelist` got registered verbatim on the export server —
 * including `call_external_tool`, the un-gated egress bridge. `start()` now
 * intersects with this list, and `rendererWritableSettingsSchema` bounds the
 * settings field to the same enumeration.
 *
 * Canonical definition lives in `packages/net/config.ts`
 * (`EXPORTABLE_MCP_TOOLS`) because the settings schema needs it and
 * `packages/net` must not import from `electron/`. Re-exported here under the
 * historical name so the tool-whitelist trio (`ALLOWED_TOOLS` /
 * `ALL_EXPORTABLE_TOOLS` / `DEFAULT_EXPORT_WHITELIST`, CLAUDE.md §4) stays
 * greppable from the service that enforces it.
 */
export const ALL_EXPORTABLE_TOOLS: readonly string[] = EXPORTABLE_MCP_TOOLS

/**
 * Intersect a list of tool names with the export ceiling.
 *
 * The ONLY place a name becomes exportable. Both the explicit-whitelist path
 * and the default path go through here — see `resolveExportWhitelist`.
 */
function intersectWithExportCeiling(names: readonly unknown[]): Set<string> {
  const allowed = new Set<string>()
  let dropped = 0
  for (const name of names) {
    if (typeof name === 'string' && isExportableMcpTool(name)) allowed.add(name)
    else dropped++
  }
  if (dropped > 0) {
    // Count only: entries originate from renderer-writable settings, and an
    // attacker-chosen tool name is attacker-chosen free text (same reasoning
    // as the hashed identifiers in ai.ts `call_external_tool` logging).
    log.warn(`MCP export whitelist: dropped ${dropped} entry/entries outside ALL_EXPORTABLE_TOOLS`)
  }
  return allowed
}

/**
 * Narrow an incoming whitelist to what may actually be exported.
 *
 * `undefined` means "caller expressed no preference" → the read-only default.
 * An explicit list is INTERSECTED with the ceiling: unknown or de-listed names
 * are dropped, never registered. An explicit list whose every entry is dropped
 * yields an EMPTY set (a server with no tools), not the default — the caller
 * asked for something specific and none of it was allowed; silently falling
 * back to twelve read-only tools would be a widening.
 *
 * The default list is NOT a trusted shortcut: it goes through the same
 * intersection. It used to be returned verbatim, which meant the ceiling was
 * enforced on one of the two branches only — the day a tool is added to the
 * default and forgotten in `EXPORTABLE_MCP_TOOLS` (or removed from the ceiling
 * and forgotten in the default), that branch would export it anyway, both at
 * startup and on every call without an explicit list. The type annotation on
 * `DEFAULT_EXPORT_WHITELIST` catches the same mistake at compile time; this is
 * the runtime half of the same guarantee, so neither depends on the other.
 */
export function resolveExportWhitelist(whitelist?: readonly string[]): Set<string> {
  return intersectWithExportCeiling(whitelist ?? DEFAULT_EXPORT_WHITELIST)
}

/**
 * Test-only seam for the default-path intersection.
 *
 * Exists so a spec can feed a synthetic "default" containing an out-of-ceiling
 * name and observe it being dropped — the production default cannot carry one
 * (it would not compile), and a guarantee nobody can exercise is a guarantee
 * nobody notices losing. Production code must call `resolveExportWhitelist`.
 */
export const __intersectWithExportCeilingForTest = intersectWithExportCeiling

/**
 * Build the per-session egress/internet gates for an export connection.
 *
 * §2.158: `createMailMcpServer` was called with the tool filter alone, so the
 * handlers that consult these gates (`list_external_tools` /
 * `call_external_tool`) ran with `egressGate === undefined` — i.e. no policy at
 * all — while the chat path (`aiChat()`) always builds both. The export server
 * must never be more permissive than chat.
 *
 * Same construction as chat, with two deliberate differences, both in the
 * restrictive direction:
 *   - `perRequestConsent` is always `false`. Per-request consent is a click in
 *     the AI panel attached to one chat turn; an external client has no turn to
 *     attach it to and cannot claim it.
 *   - the per-turn consent state is pre-decided instead of left `'unset'`.
 *     Chat leaves it unset so `interceptInternetTool` can ask the user; an
 *     export session is headless and unattended, so "ask" would mean an
 *     out-of-band modal raised by a background process — a prompt-fatigue
 *     surface an attacker could spam. `allow` policy → `'approved'` (mirrors
 *     the chat pre-seed); anything else → `'denied'`, which short-circuits the
 *     interceptor at step 1 and returns the SAME `deniedToolResult(...)` payload
 *     the chat path returns when the user declines, with the audit row and
 *     `ai.egress.intercepted` telemetry still emitted.
 *
 * The gate is intentionally NOT registered in the `aiInternetGate` registry:
 * registration exists so the renderer's approve/deny IPC can resolve a pending
 * prompt, and this gate never has pendings. Not registering also means no
 * cleanup obligation when a session dies without a DELETE.
 *
 * Settings are read per session (not at `start()`) so flipping
 * `aiEgressPolicy` in Settings takes effect on the next connection without a
 * server restart.
 */
export function buildExportGates(): { egressGate: EgressGate; internetGate: InternetGate } {
  const settings = getSettings()
  const egressGate = createEgressGate({
    policy: coerceEgressPolicy(settings.aiEgressPolicy),
    context: null,
    perRequestConsent: false,
  })
  // §2.218 — attribution is EXPLICIT, never borrowed from `Settings`. This used
  // to read `settings.aiProvider ?? 'subscription'`, which named an AI provider
  // that had issued no request and, when the user had configured none, fell back
  // to a value that has since been removed from the registry entirely (an unset
  // provider would now substitute an unregistered id). An export session runs
  // tools for an EXTERNAL client and has no AI provider behind it, so it says so.
  // Deliberately NOT a refusal: the label feeds the audit log only (no gate
  // decision reads it), and MCP export is routinely used precisely by people who
  // run no in-app AI provider — refusing them a session over a log label would
  // break the feature's main use case. See `EgressAttribution`.
  const internetGate = createInternetGate({
    requestId: `mcp-export:${randomUUID()}`,
    provider: 'mcp-export',
  })
  internetGate.consentForTurn = shouldDenyEgress(egressGate) ? 'denied' : 'approved'
  return { egressGate, internetGate }
}

export type McpExportStatus = 'running' | 'stopped' | 'error'

interface Session {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

/**
 * Check if an Origin header matches a localhost variant (with optional port).
 * E.g. "http://localhost:3000" → true, "https://evil.com" → false.
 */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const base = `${url.protocol}//${url.hostname}`
    return ALLOWED_ORIGINS.has(base)
  } catch {
    return false
  }
}

/** Maximum concurrent MCP sessions to prevent resource exhaustion */
const MAX_SESSIONS = 10

export class McpExportServer {
  private httpServer: Server | null = null
  private sessions = new Map<string, Session>()
  // Same resolution as `start()` — the pre-start value must not be a second,
  // unfiltered way of spelling the default set.
  private allowedTools = resolveExportWhitelist()
  private _port = 0
  private _token = ''

  get port(): number { return this._port }
  get token(): string { return this._token }
  get status(): McpExportStatus { return this.httpServer ? 'running' : 'stopped' }

  async start(port: number, whitelist?: string[]): Promise<void> {
    if (this.httpServer) throw new Error('MCP export server already running')

    // §2.158: intersect with the ceiling. This is the single enforcement
    // point for BOTH callers — the startup path in main.ts and the
    // `mcpExport:start` IPC — so neither can widen the surface.
    this.allowedTools = resolveExportWhitelist(whitelist)
    this._port = port
    this._token = randomUUID()

    const httpServer = createServer((req, res) => {
      void this.handleHttp(req, res).catch(err => {
        log.error('HTTP handler error', err instanceof Error ? err.message : err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', reject)
        const addr = httpServer.address()
        if (addr && typeof addr !== 'string') this._port = addr.port
        resolve()
      })
    })

    this.httpServer = httpServer
    log.info(`MCP export server started on 127.0.0.1:${this._port} (${this.allowedTools.size} tools, token: ${this._token.slice(0, 8)}…)`)
  }

  async stop(): Promise<void> {
    const entries = [...this.sessions.entries()]
    this.sessions.clear()
    for (const [, session] of entries) {
      try {
        await session.transport.close()
        await session.server.close()
      } catch { /* ignore cleanup errors */ }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this._token = ''
    log.info('MCP export server stopped')
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS: only allow localhost origins (prevents browser-based CSRF from remote sites)
    const origin = req.headers['origin']
    if (origin && isLocalhostOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }))
      return
    }

    // Bearer token authentication (timing-safe comparison)
    const authHeader = req.headers['authorization']
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
    const tokenBuf = Buffer.from(token ?? '', 'utf-8')
    const expectedBuf = Buffer.from(this._token, 'utf-8')
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized. Provide a valid Bearer token in the Authorization header.' }))
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (req.method === 'POST') {
      const body = await readBody(req)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      const existing = sessionId ? this.sessions.get(sessionId) : undefined
      if (existing) {
        await existing.transport.handleRequest(req, res, parsed)
        return
      }

      // New session — reject if too many active sessions
      if (this.sessions.size >= MAX_SESSIONS) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Too many sessions (max ${MAX_SESSIONS}). Close existing sessions first.` }))
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          this.sessions.set(id, { server: mcpServer, transport })
          log.info(`MCP export session opened: ${id}`)
        },
      })

      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) {
          this.sessions.delete(sid)
          log.info(`MCP export session closed: ${sid}`)
        }
      }

      // §2.158: the export path runs through the same egress/internet gates as
      // the chat path — see `buildExportGates()` for the two deliberate
      // (restrictive) differences. No `abortSignal`: an export session has no
      // cancellable AI request behind it, and the consent state is pre-decided
      // so nothing ever waits.
      const { egressGate, internetGate } = buildExportGates()
      const mcpServer = createMailMcpServer(this.allowedTools, egressGate, internetGate)
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, parsed)
    } else if (req.method === 'GET') {
      // SSE stream for existing session
      if (!sessionId || !this.sessions.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }))
        return
      }
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res)
    } else if (req.method === 'DELETE') {
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!
        this.sessions.delete(sessionId)
        await session.transport.close()
        await session.server.close()
      }
      res.writeHead(200)
      res.end()
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
    }
  }
}

const MAX_BODY_BYTES = 1024 * 1024 // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES && !rejected) {
        rejected = true
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      if (!rejected) chunks.push(chunk)
    })
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8')) })
    req.on('error', (err) => { if (!rejected) reject(err) })
  })
}
