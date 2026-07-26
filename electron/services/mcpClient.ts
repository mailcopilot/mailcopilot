/**
 * MCP Client Manager — connects to external MCP servers (Obsidian, task managers, calendars, etc.)
 * and exposes their tools to the AI assistant via bridge instruments.
 *
 * Supports two transport types:
 * - SSE/StreamableHTTP: connect via URL (http://localhost:PORT/...)
 * - stdio: spawn a local process (e.g. `npx @some/mcp-server`)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import type { McpConnectionConfig } from '../../packages/net/config'
import { getSettings, isAllowedMcpStdioCommand } from '../../packages/net/config'

const log = createLogger('McpStdio')

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000

/**
 * Whitelist of environment variables passed through to stdio MCP subprocesses
 * (§3.10 P0). The MCP SDK's `StdioClientTransport` used to inherit
 * `process.env` wholesale, which meant every environment secret MailCopilot
 * has access to (Sentry DSN, provider API keys picked up from the user shell,
 * internal proxy credentials, `MAILCOPILOT_*` flags that may carry tokens)
 * would leak into an attacker-chosen subprocess. A compromised renderer that
 * reaches `mcp:connect` after the approval gate still must not be able to
 * siphon env secrets via the subprocess it spawns.
 *
 * This list is the intentional minimum for a local process to run at all:
 *   - PATH: absolutely required to resolve the command name.
 *   - HOME: npm / pip / uv resolve user-level caches against this.
 *   - LANG, LC_ALL, LC_CTYPE: locale for tools that emit localized output
 *     or reject UTF-8 without an explicit locale.
 *   - TZ: some MCP servers log timestamps in the user's timezone.
 *   - TERM: TTY-aware tools need a valid terminal string, else they emit
 *     ANSI escapes on stdout and confuse the MCP JSON-RPC stream.
 *
 * Per-connection `env` overrides set via Settings are layered ON TOP of this
 * base — users who need `OPENAI_API_KEY` in their MCP server explicitly
 * declare it in the connection config, which is a deliberate act.
 */
const STDIO_ENV_WHITELIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
] as const

function buildStdioEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of STDIO_ENV_WHITELIST) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value
    }
  }
  return env
}

/**
 * SHA-256 hash of the `command + ' ' + args.join(' ')` tuple (§3.10 P0).
 * Exposed so audit/telemetry callers never handle the raw command string.
 */
export function hashStdioCommand(command: string, args: readonly string[] | undefined): string {
  const joined = args && args.length > 0 ? `${command} ${args.join(' ')}` : command
  return createHash('sha256').update(joined).digest('hex')
}

/**
 * Decide whether stdio MCP is globally enabled. Two legitimate sources:
 *   - `MAILCOPILOT_ENABLE_STDIO_MCP=1` env flag (developer / CI).
 *   - Persisted `stdioApproved` record from a native-confirm dialog,
 *     matched to the current app version (see §3.10 P0 requirement #2).
 *
 * Returns `{ enabled, source }`. `source` carries through to the
 * per-connection approvedSource so audit/telemetry can tell "user clicked
 * through a dialog yesterday" apart from "developer is running with the
 * env flag today" — the former is a persistent grant, the latter is
 * scoped to the dev session.
 */
export function resolveStdioGate(
  currentAppVersion: string,
): { enabled: boolean; source: 'env' | 'native-confirm' | null } {
  if (process.env.MAILCOPILOT_ENABLE_STDIO_MCP === '1') {
    return { enabled: true, source: 'env' }
  }
  try {
    const s = getSettings()
    if (s.mcpEnableStdio === true && s.stdioApproved?.source === 'native-confirm') {
      // Approval is pinned to app version — on upgrade the user must re-confirm.
      // This is conservative by design: an approval granted for v1 stdio
      // semantics should not silently carry into v2, where stdio gating rules
      // may have changed.
      if (s.stdioApproved.appVersion === currentAppVersion) {
        return { enabled: true, source: 'native-confirm' }
      }
    }
  } catch {
    // Settings store unavailable — fail closed.
  }
  return { enabled: false, source: null }
}

/**
 * Per-connection enabled + approval-source resolver. Layers the global gate
 * on top of the connection's persisted `approvedSource`:
 *   - Global gate disabled → connection disabled (regardless of
 *     `approvedSource`).
 *   - Global gate enabled via env → auto-upgrade the connection to an
 *     'env' approval (env mode trusts the developer).
 *   - Global gate enabled via native-confirm → connection must have its
 *     OWN `approvedSource: 'native-confirm'` set via
 *     `mcp:approveStdioConnection`.
 */
export function resolveConnectionApproval(
  config: McpConnectionConfig,
  currentAppVersion: string,
): { approved: boolean; source: 'env' | 'native-confirm' | null; reason?: 'env_disabled' | 'not_approved' } {
  if (config.transport !== 'stdio') {
    // SSE is loopback-only (see assertTrustedMcpConnectionConfig) — approval
    // concept does not apply.
    return { approved: true, source: null }
  }
  const gate = resolveStdioGate(currentAppVersion)
  if (!gate.enabled) return { approved: false, source: null, reason: 'env_disabled' }
  if (gate.source === 'env') return { approved: true, source: 'env' }
  if (config.approvedSource === 'native-confirm') return { approved: true, source: 'native-confirm' }
  return { approved: false, source: null, reason: 'not_approved' }
}

/**
 * @deprecated Prefer `resolveStdioGate` + `resolveConnectionApproval` which
 * returns structured info for audit/telemetry. Kept for tests that still
 * exercise the boolean form via the public legacy entrypoint.
 */
function isStdioMcpEnabled(): boolean {
  if (process.env.MAILCOPILOT_ENABLE_STDIO_MCP === '1') return true
  try { return getSettings().mcpEnableStdio === true } catch { return false }
}

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export type { McpConnectionConfig }

export type ExternalMcpTool = {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: unknown
}

export type ConnectionInfo = {
  status: ConnectionStatus
  error?: string
  toolCount: number
}

function isLoopbackHostname(hostnameRaw: string): boolean {
  const hostname = hostnameRaw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1') return true
  return net.isIP(hostname) === 4 && hostname.startsWith('127.')
}

export function assertTrustedMcpConnectionConfig(config: McpConnectionConfig): void {
  if (config.transport !== 'sse') return
  if (!config.url) throw new Error('SSE transport requires a URL')

  const url = new URL(config.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SSE MCP transport only supports http/https URLs')
  }
  if (url.username || url.password) {
    throw new Error('SSE MCP transport does not allow embedded credentials')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('SSE MCP transport is restricted to localhost/loopback endpoints')
  }
}

interface ManagedConnection {
  client: Client
  transport: InstanceType<typeof StreamableHTTPClientTransport> | InstanceType<typeof StdioClientTransport>
  config: McpConnectionConfig
  status: ConnectionStatus
  error?: string
  tools: ExternalMcpTool[]
}

export class McpClientManager {
  private connections = new Map<string, ManagedConnection>()

  async connect(config: McpConnectionConfig): Promise<void> {
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id)
    }

    const client = new Client({ name: 'mailcopilot', version: '1.0.0' })
    const conn: ManagedConnection = {
      client,
      transport: null!,
      config,
      status: 'connecting',
      tools: [],
    }
    this.connections.set(config.id, conn)

    try {
      const transport = this.createTransport(config)
      conn.transport = transport

      transport.onerror = (err: Error) => {
        log.error(`MCP connection "${config.name}" error: ${err.message}`)
        captureException(err, { source: 'mcpClient', stage: 'transport', connectionName: config.name })
        conn.status = 'error'
        conn.error = err.message
      }

      transport.onclose = () => {
        log.info(`MCP connection "${config.name}" closed`)
        conn.status = 'disconnected'
        conn.tools = []
      }

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS)
      try {
        await client.connect(transport, { signal: ac.signal })
      } finally {
        clearTimeout(timer)
      }

      // Fetch tools from the server
      conn.tools = await this.fetchTools(config.id, config.name, client)
      conn.status = 'connected'
      conn.error = undefined
      log.info(`MCP connection "${config.name}" established (${conn.tools.length} tools)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`MCP connection "${config.name}" failed: ${msg}`)
      captureException(err, { source: 'mcpClient', stage: 'connect', connectionName: config.name })
      conn.status = 'error'
      conn.error = msg
      // Clean up partial connection
      try { await client.close() } catch { /* ignore */ }
      throw err
    }
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    try {
      await conn.client.close()
    } catch { /* ignore */ }
    conn.status = 'disconnected'
    conn.tools = []
    this.connections.delete(id)
    log.info(`MCP connection "${conn.config.name}" disconnected`)
  }

  async reconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) throw new Error(`Connection "${id}" not found`)
    const config = conn.config
    await this.disconnect(id)
    await this.connect(config)
  }

  async listAllTools(): Promise<ExternalMcpTool[]> {
    const tools: ExternalMcpTool[] = []
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        tools.push(...conn.tools)
      }
    }
    return tools
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverId)
    if (!conn) throw new Error(`Server "${serverId}" not connected`)
    if (conn.status !== 'connected') throw new Error(`Server "${serverId}" is ${conn.status}`)

    const result = await conn.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    )
    return result
  }

  getStatus(id: string): ConnectionInfo {
    const conn = this.connections.get(id)
    if (!conn) return { status: 'disconnected', toolCount: 0 }
    return { status: conn.status, error: conn.error, toolCount: conn.tools.length }
  }

  getAllStatuses(): Record<string, ConnectionInfo> {
    const result: Record<string, ConnectionInfo> = {}
    for (const [id, conn] of this.connections) {
      result[id] = { status: conn.status, error: conn.error, toolCount: conn.tools.length }
    }
    return result
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.allSettled(ids.map(id => this.disconnect(id)))
  }

  private createTransport(config: McpConnectionConfig) {
    assertTrustedMcpConnectionConfig(config)

    if (config.transport === 'stdio') {
      // Back-stop: primary enforcement of the §3.10 P0 approval gate lives
      // in the `mcp:connect` IPC handler (main.ts) where we can emit rich
      // audit/telemetry with the caller's context. This boolean fallback
      // remains as a second line of defence for any direct in-process
      // caller that bypasses IPC.
      if (!isStdioMcpEnabled()) {
        throw new Error('stdio MCP transport is disabled by default; set MAILCOPILOT_ENABLE_STDIO_MCP=1 or grant native-confirm approval to enable it')
      }
      if (!config.command) throw new Error('stdio transport requires a command')
      // Defense-in-depth: reject any stdio command outside the built-in
      // allowlist at transport-creation time. The IPC save handler already
      // enforces this at `mcp:saveConnection`; re-checking here protects
      // against a bypass that mutates the persisted settings file directly.
      if (!isAllowedMcpStdioCommand(config.command)) {
        throw new Error(`stdio MCP command "${config.command}" is not in the built-in allowlist`)
      }
      // Env whitelist (§3.10 P0 requirement #5). Build a clean env from the
      // six allowed host vars, then overlay the user-declared per-connection
      // overrides. `process.env` never leaks into the subprocess wholesale.
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildStdioEnv(config.env),
      })
    }

    // StreamableHTTP transport (supports both modern StreamableHTTP and legacy SSE servers)
    if (!config.url) throw new Error('sse transport requires a URL')
    return new StreamableHTTPClientTransport(new URL(config.url))
  }

  private async fetchTools(serverId: string, serverName: string, client: Client): Promise<ExternalMcpTool[]> {
    const tools: ExternalMcpTool[] = []
    let cursor: string | undefined

    do {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: CALL_TIMEOUT_MS },
      )
      for (const tool of result.tools) {
        tools.push({
          serverId,
          serverName,
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        })
      }
      cursor = result.nextCursor
    } while (cursor)

    return tools
  }
}
