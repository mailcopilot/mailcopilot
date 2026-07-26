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
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMailMcpServer } from './ai'
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

/** Default read-only tools exposed to external clients */
export const DEFAULT_EXPORT_WHITELIST = [
  'get_email', 'list_emails', 'search_emails',
  'list_folders', 'get_thread', 'get_contacts',
  'get_account_info', 'count_unread', 'query_db',
  'list_attachments', 'read_attachment', 'get_attachment_hash',
]

/** All tool names that can be exported (for UI checkboxes).
 *
 * §3.10 P0: every mutating tool is now a preview_* / apply_* pair. The direct
 * variants (snooze_email, flag_email, add_followup, dismiss_followup,
 * mark_read_later, create_mail_rule, update_mail_rule, delete_mail_rule) have
 * been removed from this list — they are no longer registered on the MCP
 * server. Existing pairs (mail_action, unsubscribe, send_email, move_email)
 * remain. */
export const ALL_EXPORTABLE_TOOLS = [
  // Read-only
  'get_email', 'list_emails', 'search_emails',
  'list_folders', 'get_thread', 'get_contacts',
  'get_account_info', 'count_unread', 'query_db',
  'list_attachments', 'read_attachment', 'get_attachment_hash',
  'get_current_context',
  'list_mail_rules', 'get_rule_log',
  // Destructive — preview/apply pairs (disabled by default).
  // External clients calling apply_* without a renderer-issued
  // confirmation_token will be rejected at the validation gate.
  'preview_mail_action', 'apply_mail_action',
  'preview_unsubscribe', 'apply_unsubscribe',
  'send_email_preview', 'send_email_apply',
  'move_email_preview', 'move_email_apply',
  'preview_snooze_email', 'apply_snooze_email',
  'preview_unsnooze_email', 'apply_unsnooze_email',
  'preview_flag_email', 'apply_flag_email',
  'preview_mark_read_later', 'apply_mark_read_later',
  'preview_add_followup', 'apply_add_followup',
  'preview_dismiss_followup', 'apply_dismiss_followup',
  'preview_create_mail_rule', 'apply_create_mail_rule',
  'preview_update_mail_rule', 'apply_update_mail_rule',
  'preview_delete_mail_rule', 'apply_delete_mail_rule',
  // Compose (no-send) + memory.
  'create_draft', 'update_memory',
]

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
  private allowedTools = new Set(DEFAULT_EXPORT_WHITELIST)
  private _port = 0
  private _token = ''

  get port(): number { return this._port }
  get token(): string { return this._token }
  get status(): McpExportStatus { return this.httpServer ? 'running' : 'stopped' }

  async start(port: number, whitelist?: string[]): Promise<void> {
    if (this.httpServer) throw new Error('MCP export server already running')

    this.allowedTools = new Set(whitelist ?? DEFAULT_EXPORT_WHITELIST)
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

      const mcpServer = createMailMcpServer(this.allowedTools)
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
