import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))

// Mock MCP SDK
const mockConnect = vi.fn()
const mockClose = vi.fn()
const mockListTools = vi.fn()
const mockCallTool = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}))

const mockStreamableTransport = { onerror: null as unknown, onclose: null as unknown }
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => mockStreamableTransport),
}))

const mockStdioTransport = { onerror: null as unknown, onclose: null as unknown }
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => mockStdioTransport),
}))
// Re-import the mocked StdioClientTransport so §3.10 P0 env-whitelist assertions
// can inspect the constructor arg. vi.mocked() requires the import to happen
// after vi.mock registration — use a dynamic import inside the test body
// (see the env-whitelist tests below).

// Mock config module. Kept mutable so individual tests can script the
// `getSettings()` return value to exercise the native-confirm branch of
// `resolveStdioGate` and `resolveConnectionApproval` (§3.10 P0).
type MockSettings = {
  mcpEnableStdio?: boolean
  stdioApproved?: { source: 'native-confirm'; approvedAt: string; appVersion: string }
}
const mockSettingsRef: { current: MockSettings } = { current: { mcpEnableStdio: false } }
vi.mock('../../packages/net/config', () => ({
  getSettings: () => mockSettingsRef.current,
  isAllowedMcpStdioCommand: (cmd: string) => ['node', 'npx', 'python', 'python3', 'uv', 'uvx', 'bun', 'deno'].includes(cmd),
}))

import {
  McpClientManager,
  resolveStdioGate,
  resolveConnectionApproval,
  hashStdioCommand,
  type McpConnectionConfig,
} from './mcpClient'

const sseConfig: McpConnectionConfig = {
  id: 'test-sse',
  name: 'Test SSE',
  transport: 'sse',
  url: 'http://localhost:27182',
  enabled: true,
  autoConnect: false,
}

const stdioConfig: McpConnectionConfig = {
  id: 'test-stdio',
  name: 'Test Stdio',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@some/mcp-server'],
  enabled: true,
  autoConnect: true,
}

describe('McpClientManager', () => {
  let manager: McpClientManager
  const savedStdioEnv = process.env.MAILCOPILOT_ENABLE_STDIO_MCP

  beforeEach(() => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    manager = new McpClientManager()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockListTools.mockResolvedValue({ tools: [], nextCursor: undefined })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  })

  afterEach(async () => {
    if (savedStdioEnv === undefined) delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    else process.env.MAILCOPILOT_ENABLE_STDIO_MCP = savedStdioEnv
    await manager.disconnectAll()
  })

  it('connects to SSE server', async () => {
    await manager.connect(sseConfig)
    expect(mockConnect).toHaveBeenCalledOnce()
    expect(manager.getStatus('test-sse').status).toBe('connected')
  })

  it('connects to stdio server', async () => {
    await manager.connect(stdioConfig)
    expect(mockConnect).toHaveBeenCalledOnce()
    expect(manager.getStatus('test-stdio').status).toBe('connected')
  })

  it('disconnects from server', async () => {
    await manager.connect(sseConfig)
    await manager.disconnect('test-sse')
    expect(mockClose).toHaveBeenCalled()
    expect(manager.getStatus('test-sse').status).toBe('disconnected')
  })

  it('reconnects to server', async () => {
    await manager.connect(sseConfig)
    await manager.reconnect('test-sse')
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(manager.getStatus('test-sse').status).toBe('connected')
  })

  it('throws on reconnect for unknown id', async () => {
    await expect(manager.reconnect('unknown')).rejects.toThrow('not found')
  })

  it('lists tools from connected servers', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object' } },
        { name: 'tool2', description: 'Tool 2', inputSchema: { type: 'object' } },
      ],
      nextCursor: undefined,
    })
    await manager.connect(sseConfig)
    const tools = await manager.listAllTools()
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('tool1')
    expect(tools[0].serverId).toBe('test-sse')
    expect(tools[0].serverName).toBe('Test SSE')
  })

  it('calls tool on connected server', async () => {
    await manager.connect(sseConfig)
    const result = await manager.callTool('test-sse', 'tool1', { arg: 'value' })
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'tool1', arguments: { arg: 'value' } },
      undefined,
      { timeout: 30_000 },
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('throws on callTool for disconnected server', async () => {
    await expect(manager.callTool('unknown', 'tool', {})).rejects.toThrow('not connected')
  })

  it('handles connection errors', async () => {
    mockConnect.mockRejectedValue(new Error('Connection refused'))
    await expect(manager.connect(sseConfig)).rejects.toThrow('Connection refused')
    expect(manager.getStatus('test-sse').status).toBe('error')
    expect(manager.getStatus('test-sse').error).toBe('Connection refused')
  })

  it('getAllStatuses returns all connections', async () => {
    await manager.connect(sseConfig)
    await manager.connect(stdioConfig)
    const statuses = manager.getAllStatuses()
    expect(Object.keys(statuses)).toHaveLength(2)
    expect(statuses['test-sse'].status).toBe('connected')
    expect(statuses['test-stdio'].status).toBe('connected')
  })

  it('disconnectAll disconnects all connections', async () => {
    await manager.connect(sseConfig)
    await manager.connect(stdioConfig)
    await manager.disconnectAll()
    expect(manager.getStatus('test-sse').status).toBe('disconnected')
    expect(manager.getStatus('test-stdio').status).toBe('disconnected')
  })

  it('disconnect is safe for unknown id', async () => {
    await expect(manager.disconnect('unknown')).resolves.not.toThrow()
  })

  it('throws for SSE transport without URL', async () => {
    const bad: McpConnectionConfig = { ...sseConfig, url: undefined }
    await expect(manager.connect(bad)).rejects.toThrow('URL')
  })

  it('rejects non-loopback SSE endpoints', async () => {
    const bad: McpConnectionConfig = { ...sseConfig, url: 'https://example.com/mcp' }
    await expect(manager.connect(bad)).rejects.toThrow('localhost/loopback')
  })

  it('rejects SSE URLs with embedded credentials', async () => {
    const bad: McpConnectionConfig = { ...sseConfig, url: 'http://user:pass@localhost:27182/mcp' }
    await expect(manager.connect(bad)).rejects.toThrow('embedded credentials')
  })

  it('throws for stdio transport without command', async () => {
    const bad: McpConnectionConfig = { ...stdioConfig, command: undefined }
    await expect(manager.connect(bad)).rejects.toThrow('command')
  })

  it('blocks stdio transport when the env flag is disabled', async () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    const disabledManager = new McpClientManager()
    await expect(disabledManager.connect(stdioConfig)).rejects.toThrow('disabled by default')
    await disabledManager.disconnectAll()
  })

  it('rejects stdio transport for commands outside the allowlist', async () => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    const bad: McpConnectionConfig = { ...stdioConfig, command: '/usr/bin/evil-binary' }
    await expect(manager.connect(bad)).rejects.toThrow('allowlist')
  })

  it('passes only the env whitelist (not process.env) to StdioClientTransport', async () => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    process.env.MAILCOPILOT_TOKEN = 'super-secret-token-should-not-leak'
    process.env.SENTRY_AUTH_TOKEN = 'another-sentry-secret'
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const stdioMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>
    stdioMock.mockClear()

    await manager.connect(stdioConfig)
    expect(stdioMock).toHaveBeenCalledOnce()
    const callArg = stdioMock.mock.calls[0][0] as { env: Record<string, string> }
    expect(callArg.env).toBeDefined()
    // Secret env vars must NOT be present.
    expect(callArg.env.MAILCOPILOT_TOKEN).toBeUndefined()
    expect(callArg.env.SENTRY_AUTH_TOKEN).toBeUndefined()
    // Whitelisted env keys may be present (if the host has them set).
    // We don't assert specific values — just that none of the non-whitelisted
    // keys leaked through.
    const allowedKeys = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'])
    for (const key of Object.keys(callArg.env)) {
      expect(allowedKeys.has(key)).toBe(true)
    }

    delete process.env.MAILCOPILOT_TOKEN
    delete process.env.SENTRY_AUTH_TOKEN
  })

  it('layers user-declared per-connection env on top of the whitelist', async () => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const stdioMock = StdioClientTransport as unknown as ReturnType<typeof vi.fn>
    stdioMock.mockClear()
    const withEnv: McpConnectionConfig = {
      ...stdioConfig,
      env: { OPENAI_API_KEY: 'sk-user-declared' },
    }
    await manager.connect(withEnv)
    const callArg = stdioMock.mock.calls[0][0] as { env: Record<string, string> }
    // User-declared value is present because they explicitly chose to share it.
    expect(callArg.env.OPENAI_API_KEY).toBe('sk-user-declared')
  })

  it('replaces existing connection on re-connect', async () => {
    await manager.connect(sseConfig)
    await manager.connect(sseConfig)
    expect(mockClose).toHaveBeenCalled()
    expect(manager.getStatus('test-sse').status).toBe('connected')
  })

  it('paginates tool listing', async () => {
    mockListTools
      .mockResolvedValueOnce({
        tools: [{ name: 'page1', description: 'p1', inputSchema: { type: 'object' } }],
        nextCursor: 'cursor1',
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'page2', description: 'p2', inputSchema: { type: 'object' } }],
        nextCursor: undefined,
      })
    await manager.connect(sseConfig)
    const tools = await manager.listAllTools()
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('page1')
    expect(tools[1].name).toBe('page2')
  })
})

describe('§3.10 P0 approval helpers', () => {
  const savedStdioEnv = process.env.MAILCOPILOT_ENABLE_STDIO_MCP

  beforeEach(() => {
    // Reset mocked settings so each test starts from a clean slate.
    mockSettingsRef.current = { mcpEnableStdio: false }
  })

  afterEach(() => {
    if (savedStdioEnv === undefined) delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    else process.env.MAILCOPILOT_ENABLE_STDIO_MCP = savedStdioEnv
    mockSettingsRef.current = { mcpEnableStdio: false }
  })

  it('resolveStdioGate returns env source when env flag is set', () => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: true, source: 'env' })
  })

  it('resolveStdioGate returns disabled when env flag absent and no persisted approval', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: false, source: null })
  })

  it('resolveConnectionApproval passes SSE through without a gate', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    const result = resolveConnectionApproval(sseConfig, '1.20.1')
    expect(result.approved).toBe(true)
  })

  it('resolveConnectionApproval blocks stdio when global gate is disabled', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    const result = resolveConnectionApproval(stdioConfig, '1.20.1')
    expect(result.approved).toBe(false)
    expect(result.reason).toBe('env_disabled')
  })

  it('resolveConnectionApproval auto-approves stdio when env gate is on', () => {
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    const result = resolveConnectionApproval(stdioConfig, '1.20.1')
    expect(result.approved).toBe(true)
    expect(result.source).toBe('env')
  })

  it('hashStdioCommand produces stable SHA-256 hex', () => {
    const h1 = hashStdioCommand('npx', ['-y', '@some/mcp-server'])
    const h2 = hashStdioCommand('npx', ['-y', '@some/mcp-server'])
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashStdioCommand differs when args differ', () => {
    const h1 = hashStdioCommand('npx', ['-y', '@some/mcp-server'])
    const h2 = hashStdioCommand('npx', ['-y', '@other/mcp-server'])
    expect(h1).not.toBe(h2)
  })

  // --- resolveStdioGate: native-confirm branch coverage ---

  it('resolveStdioGate enables via native-confirm when appVersion matches', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = {
      mcpEnableStdio: true,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.20.1' },
    }
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: true, source: 'native-confirm' })
  })

  it('resolveStdioGate rejects stale approval when appVersion mismatches (upgrade invalidates approval)', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = {
      mcpEnableStdio: true,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.19.0' },
    }
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: false, source: null })
  })

  it('resolveStdioGate rejects when mcpEnableStdio is false even with valid approval record', () => {
    // Defense-in-depth: if a reader clears mcpEnableStdio (e.g. Settings UI toggle),
    // a dangling stdioApproved record from a previous grant must not re-enable stdio.
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = {
      mcpEnableStdio: false,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.20.1' },
    }
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: false, source: null })
  })

  it('resolveStdioGate rejects when stdioApproved is missing even if mcpEnableStdio is true', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = { mcpEnableStdio: true }
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: false, source: null })
  })

  it('resolveStdioGate fails closed when getSettings throws', () => {
    // Simulate a corrupted settings store — the gate must fail closed, not
    // leak through an exception.
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    const original = mockSettingsRef.current
    Object.defineProperty(mockSettingsRef, 'current', {
      get() { throw new Error('settings store unavailable') },
      configurable: true,
    })
    try {
      expect(resolveStdioGate('1.20.1')).toEqual({ enabled: false, source: null })
    } finally {
      Object.defineProperty(mockSettingsRef, 'current', {
        value: original,
        writable: true,
        configurable: true,
      })
    }
  })

  it('resolveStdioGate prefers env flag over native-confirm when both are present', () => {
    // Env flag takes precedence — developer session wins.
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    mockSettingsRef.current = {
      mcpEnableStdio: true,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.20.1' },
    }
    expect(resolveStdioGate('1.20.1')).toEqual({ enabled: true, source: 'env' })
  })

  // --- resolveConnectionApproval: native-confirm branch coverage ---

  it('resolveConnectionApproval blocks stdio under native-confirm gate when connection lacks its own approval', () => {
    // §3.10 P0 layered gate: global gate on, but the individual connection
    // must still carry `approvedSource: 'native-confirm'` set by
    // `mcp:approveStdioConnection`. A saved stdio connection with
    // approvedSource=null is the common post-migration state.
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = {
      mcpEnableStdio: true,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.20.1' },
    }
    const result = resolveConnectionApproval(
      { ...stdioConfig, approvedSource: null },
      '1.20.1',
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toBe('not_approved')
  })

  it('resolveConnectionApproval grants stdio under native-confirm gate when connection carries approval', () => {
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = {
      mcpEnableStdio: true,
      stdioApproved: { source: 'native-confirm', approvedAt: '2026-04-24T00:00:00Z', appVersion: '1.20.1' },
    }
    const result = resolveConnectionApproval(
      { ...stdioConfig, approvedSource: 'native-confirm' },
      '1.20.1',
    )
    expect(result.approved).toBe(true)
    expect(result.source).toBe('native-confirm')
  })

  it('resolveConnectionApproval ignores per-connection approval when global gate is off', () => {
    // Per-connection approval must not be enough on its own — an attacker who
    // flipped the per-connection flag still needs the global gate open.
    delete process.env.MAILCOPILOT_ENABLE_STDIO_MCP
    mockSettingsRef.current = { mcpEnableStdio: false }
    const result = resolveConnectionApproval(
      { ...stdioConfig, approvedSource: 'native-confirm' },
      '1.20.1',
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toBe('env_disabled')
  })

  it('resolveConnectionApproval env gate auto-approves even when per-connection approvedSource is null', () => {
    // Developer / CI mode — env flag unconditionally grants.
    process.env.MAILCOPILOT_ENABLE_STDIO_MCP = '1'
    const result = resolveConnectionApproval(
      { ...stdioConfig, approvedSource: null },
      '1.20.1',
    )
    expect(result.approved).toBe(true)
    expect(result.source).toBe('env')
  })

  it('hashStdioCommand produces no-args canonical form when args array is empty or undefined', () => {
    // Ensures the format is stable — downstream callers rely on `command` (no
    // trailing space) when args are absent.
    const h1 = hashStdioCommand('npx', undefined)
    const h2 = hashStdioCommand('npx', [])
    expect(h1).toBe(h2)
    // And differs from the single-arg form.
    const h3 = hashStdioCommand('npx', [''])
    expect(h3).not.toBe(h1)
  })

  it('hashStdioCommand is case-sensitive on the command name', () => {
    expect(hashStdioCommand('NPX', ['-y'])).not.toBe(hashStdioCommand('npx', ['-y']))
  })
})
