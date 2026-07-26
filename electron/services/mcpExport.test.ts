import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'

// Mock ai.ts to avoid loading the entire AI module
vi.mock('./ai', () => ({
  createMailMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  })),
}))

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))

// Mock StreamableHTTPServerTransport
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation((opts) => {
    const instance = {
      sessionId: undefined as string | undefined,
      onclose: undefined as (() => void) | undefined,
      handleRequest: vi.fn(async (_req: unknown, res: http.ServerResponse) => {
        // Simulate session initialization
        if (opts?.onsessioninitialized && !instance.sessionId) {
          instance.sessionId = 'test-session-id'
          opts.onsessioninitialized(instance.sessionId)
        }
        if (!res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"jsonrpc":"2.0","result":{}}')
        }
      }),
      close: vi.fn(async () => {
        instance.onclose?.()
      }),
    }
    return instance
  }),
}))

import { McpExportServer, DEFAULT_EXPORT_WHITELIST, ALL_EXPORTABLE_TOOLS } from './mcpExport'
import { createMailMcpServer } from './ai'

function httpRequest(port: number, options: http.RequestOptions, body?: string): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, ...options }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf-8'),
        headers: res.headers,
      }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** Helper: make an authenticated request with the server's bearer token */
function authRequest(server: McpExportServer, options: http.RequestOptions, body?: string) {
  return httpRequest(server.port, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${server.token}` },
  }, body)
}

describe('McpExportServer', () => {
  let server: McpExportServer

  beforeEach(() => {
    server = new McpExportServer()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (server.status === 'running') {
      await server.stop()
    }
  })

  it('starts and stops correctly', async () => {
    expect(server.status).toBe('stopped')
    expect(server.port).toBe(0)

    await server.start(0)
    expect(server.status).toBe('running')
    expect(server.port).toBeGreaterThan(0)
    expect(server.token).toMatch(/^[0-9a-f-]{36}$/)

    await server.stop()
    expect(server.status).toBe('stopped')
    expect(server.token).toBe('')
  })

  it('throws when starting twice', async () => {
    await server.start(0)
    await expect(server.start(0)).rejects.toThrow('already running')
  })

  it('stop is safe when not running', async () => {
    await expect(server.stop()).resolves.not.toThrow()
  })

  it('responds 404 on non-/mcp path', async () => {
    await server.start(0)
    const res = await httpRequest(server.port, { method: 'GET', path: '/other' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toContain('Not found')
  })

  it('responds 204 on OPTIONS (CORS preflight)', async () => {
    await server.start(0)
    const res = await httpRequest(server.port, { method: 'OPTIONS', path: '/mcp' })
    expect(res.statusCode).toBe(204)
    // OPTIONS is exempt from auth — preflight cannot carry Authorization header
    expect(res.headers['access-control-allow-methods']).toContain('POST')
  })

  it('sets CORS header only for localhost origins', async () => {
    await server.start(0)
    // localhost origin → reflected
    const res1 = await httpRequest(server.port, {
      method: 'OPTIONS', path: '/mcp',
      headers: { Origin: 'http://localhost:3000' },
    })
    expect(res1.headers['access-control-allow-origin']).toBe('http://localhost:3000')

    // 127.0.0.1 origin → reflected
    const res2 = await httpRequest(server.port, {
      method: 'OPTIONS', path: '/mcp',
      headers: { Origin: 'http://127.0.0.1:8080' },
    })
    expect(res2.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080')

    // Remote origin → no CORS header
    const res3 = await httpRequest(server.port, {
      method: 'OPTIONS', path: '/mcp',
      headers: { Origin: 'https://evil.com' },
    })
    expect(res3.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('responds 401 without bearer token', async () => {
    await server.start(0)
    const res = await httpRequest(server.port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('Unauthorized')
  })

  it('responds 401 with wrong bearer token', async () => {
    await server.start(0)
    const res = await httpRequest(server.port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(res.statusCode).toBe(401)
  })

  it('responds 405 on unsupported method', async () => {
    await server.start(0)
    const res = await authRequest(server, { method: 'PUT', path: '/mcp' })
    expect(res.statusCode).toBe(405)
  })

  it('responds 400 on invalid JSON POST', async () => {
    await server.start(0)
    const res = await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, 'not json')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Invalid JSON')
  })

  it('creates session on valid POST with auth', async () => {
    await server.start(0)
    const res = await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(res.statusCode).toBe(200)
    expect(createMailMcpServer).toHaveBeenCalledWith(expect.any(Set))
  })

  it('passes whitelist to createMailMcpServer', async () => {
    const custom = ['get_email', 'search_emails']
    await server.start(0, custom)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(createMailMcpServer).toHaveBeenCalledWith(new Set(custom))
  })

  it('uses default whitelist when none provided', async () => {
    await server.start(0)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(createMailMcpServer).toHaveBeenCalledWith(new Set(DEFAULT_EXPORT_WHITELIST))
  })

  it('responds 400 on GET without session ID', async () => {
    await server.start(0)
    const res = await authRequest(server, { method: 'GET', path: '/mcp' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toContain('session')
  })

  it('responds 200 on DELETE', async () => {
    await server.start(0)
    const res = await authRequest(server, { method: 'DELETE', path: '/mcp' })
    expect(res.statusCode).toBe(200)
  })

  it('generates new token on restart', async () => {
    await server.start(0)
    const token1 = server.token
    await server.stop()
    await server.start(0)
    const token2 = server.token
    expect(token1).not.toBe(token2)
  })
})

describe('Export constants', () => {
  it('DEFAULT_EXPORT_WHITELIST contains only read-only tools', () => {
    const destructive = ['apply_mail_action', 'send_email_apply', 'apply_unsubscribe', 'move_email_apply']
    for (const tool of destructive) {
      expect(DEFAULT_EXPORT_WHITELIST).not.toContain(tool)
    }
  })

  it('ALL_EXPORTABLE_TOOLS contains default whitelist', () => {
    for (const tool of DEFAULT_EXPORT_WHITELIST) {
      expect(ALL_EXPORTABLE_TOOLS).toContain(tool)
    }
  })

  it('ALL_EXPORTABLE_TOOLS includes destructive tools', () => {
    expect(ALL_EXPORTABLE_TOOLS).toContain('apply_mail_action')
    expect(ALL_EXPORTABLE_TOOLS).toContain('send_email_apply')
  })

  // §3.10 P0 mirror parity: ai.ts ALLOWED_TOOLS and mcpExport ALL_EXPORTABLE_TOOLS
  // must agree on the preview/apply pair set. Without this, an external MCP
  // client could end up with mismatched checkbox UI (tools registered in MCP
  // server but absent from settings whitelist, or vice versa). The spot-check
  // for `apply_mail_action` and `send_email_apply` is not enough — a regression
  // that drops one half of a pair (e.g. forgets `preview_delete_mail_rule`)
  // would still pass.
  it('ALL_EXPORTABLE_TOOLS contains every preview/apply pair', () => {
    const pairs = [
      ['preview_mail_action', 'apply_mail_action'],
      ['preview_unsubscribe', 'apply_unsubscribe'],
      ['send_email_preview', 'send_email_apply'],
      ['move_email_preview', 'move_email_apply'],
      ['preview_snooze_email', 'apply_snooze_email'],
      ['preview_unsnooze_email', 'apply_unsnooze_email'],
      ['preview_flag_email', 'apply_flag_email'],
      ['preview_mark_read_later', 'apply_mark_read_later'],
      ['preview_add_followup', 'apply_add_followup'],
      ['preview_dismiss_followup', 'apply_dismiss_followup'],
      ['preview_create_mail_rule', 'apply_create_mail_rule'],
      ['preview_update_mail_rule', 'apply_update_mail_rule'],
      ['preview_delete_mail_rule', 'apply_delete_mail_rule'],
    ]
    for (const [preview, apply] of pairs) {
      expect(ALL_EXPORTABLE_TOOLS).toContain(preview)
      expect(ALL_EXPORTABLE_TOOLS).toContain(apply)
    }
  })

  // §3.10 P0 invariant mirror: direct mutating tools (the unguarded variants)
  // must NOT be exposed via the export server, because external MCP clients
  // bypass the renderer-issued confirmation token. Their presence here would
  // be a confused-deputy escalation path.
  it('ALL_EXPORTABLE_TOOLS excludes direct mutating tools (no preview)', () => {
    const directBanned = [
      'snooze_email', 'unsnooze_email', 'flag_email', 'mark_read_later',
      'add_followup', 'dismiss_followup',
      'create_mail_rule', 'update_mail_rule', 'delete_mail_rule',
      'mail_action', 'unsubscribe', 'send_email', 'move_email',
    ]
    for (const tool of directBanned) {
      expect(ALL_EXPORTABLE_TOOLS).not.toContain(tool)
    }
  })
})
