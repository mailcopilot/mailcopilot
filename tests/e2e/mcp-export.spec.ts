import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT } from './helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpResult = { status: number; headers: Record<string, string>; body: any }

async function mcpCall(baseUrl: string, token: string, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<McpResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const ct = resp.headers.get('content-type') ?? ''

  if (ct.includes('text/event-stream')) {
    const text = await resp.text()
    const lines = text.split('\n').filter(l => l.startsWith('data: '))
    const last = lines[lines.length - 1]
    const json = last ? JSON.parse(last.slice(6)) : {}
    return { status: resp.status, headers: Object.fromEntries(resp.headers), body: json }
  }

  return { status: resp.status, headers: Object.fromEntries(resp.headers), body: await resp.json() }
}

function toolResultText(resp: McpResult): string {
  const content = resp.body.result?.content
  if (Array.isArray(content)) {
    return content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n')
  }
  return ''
}

test('MCP export: server lifecycle and auth', async () => {
  const ctx = await launchApp()
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Start MCP export on random port
    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0) as { ok: boolean; port: number; token: string }
    })
    expect(startResult.ok).toBe(true)
    expect(startResult.port).toBeGreaterThan(0)
    expect(startResult.token).toMatch(/^[a-f0-9-]{36}$/)

    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    // Auth: no token → 401
    const noAuth = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(noAuth.status).toBe(401)

    // Auth: wrong token → 401
    const wrongAuth = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(wrongAuth.status).toBe(401)

    // Wrong path → 404
    const wrongPath = await fetch(`http://127.0.0.1:${port}/wrong`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(wrongPath.status).toBe(404)

    // Status check
    const statusResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } })
        .api.invoke('mcpExport:status')
    }) as { status: string; port: number; token: string }
    expect(statusResult.status).toBe('running')
    expect(statusResult.port).toBe(port)

    // Stop
    await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } })
        .api.invoke('mcpExport:stop')
    })

    // After stop, port should be closed
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })
      expect(false).toBe(true) // should not reach
    } catch {
      // Expected: connection refused
    }
  } finally {
    await cleanupApp(ctx)
  }
})

test('MCP export: tool discovery and whitelist', async () => {
  const ctx = await launchApp()
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    // Initialize session
    const initResp = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    })
    expect(initResp.status).toBe(200)
    const sessionId = initResp.headers['mcp-session-id']

    // List tools
    const toolsResp = await mcpCall(baseUrl, token, 'tools/list', {}, sessionId)
    const tools = toolsResp.body.result?.tools ?? []
    const toolNames = tools.map((t: { name: string }) => t.name) as string[]

    // Default whitelist: 12 read-only tools
    const expectedTools = [
      'get_email', 'list_emails', 'search_emails',
      'list_folders', 'get_thread', 'get_contacts',
      'get_account_info', 'count_unread', 'query_db',
      'list_attachments', 'read_attachment', 'get_attachment_hash',
    ]
    for (const t of expectedTools) {
      expect(toolNames).toContain(t)
    }
    expect(tools.length).toBe(expectedTools.length)

    // Destructive tools NOT exported by default
    const blocked = ['apply_mail_action', 'send_email_apply', 'move_email_apply', 'apply_unsubscribe']
    for (const t of blocked) {
      expect(toolNames).not.toContain(t)
    }

    // Each tool has name, description, inputSchema
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})

test('MCP export: list_emails and get_email return data', async () => {
  const ctx = await launchApp()
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    const initResp = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    })
    const sessionId = initResp.headers['mcp-session-id']

    // list_emails returns e2e test emails
    const emailsResp = await mcpCall(baseUrl, token, 'tools/call', {
      name: 'list_emails',
      arguments: { accountId: 1, folder: 'INBOX' },
    }, sessionId)
    expect(emailsResp.status).toBe(200)
    const emailsText = toolResultText(emailsResp)
    expect(emailsText).toContain('первое письмо')
    expect(emailsText).toContain('"emails"')
    expect(emailsText).toContain('"uid"')

    // get_email — extract a real UID from list_emails result
    const uidMatch = emailsText.match(/"uid"\s*:\s*(\d+)/)
    expect(uidMatch).toBeTruthy()
    const realUid = Number(uidMatch![1])
    const getResp = await mcpCall(baseUrl, token, 'tools/call', {
      name: 'get_email',
      arguments: { accountId: 1, folder: 'INBOX', uid: realUid },
    }, sessionId)
    expect(getResp.status).toBe(200)
    const emailText = toolResultText(getResp)
    // Should contain email metadata (subject, from address)
    expect(emailText.length).toBeGreaterThan(50)

    // search_emails
    const searchResp = await mcpCall(baseUrl, token, 'tools/call', {
      name: 'search_emails',
      arguments: { accountId: 1, query: 'html' },
    }, sessionId)
    expect(searchResp.status).toBe(200)
    const searchText = toolResultText(searchResp)
    expect(searchText).toContain('html')

    // count_unread
    const unreadResp = await mcpCall(baseUrl, token, 'tools/call', {
      name: 'count_unread',
      arguments: { accountId: 1 },
    }, sessionId)
    expect(unreadResp.status).toBe(200)
    expect(toolResultText(unreadResp)).toBeTruthy()

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// §2.158 explicit-whitelist narrowing — resolveExportWhitelist() intersects
// whatever `mcpExport:start` is handed with the export ceiling and NEVER
// falls back to the read-only default when every requested entry is invalid.
//
// These tests deliberately do NOT import `ALL_EXPORTABLE_TOOLS` /
// `EXPORTABLE_MCP_TOOLS` from `electron/services/mcpExport` or
// `packages/net/config` — those modules transitively import `packages/db`
// (`better-sqlite3`), which is compiled against Electron's ABI and would
// crash on import under Playwright's plain-Node test runner (the same ABI
// split CLAUDE.md §5 documents for `npm run test:db`). Instead they treat the
// running app as the oracle: an in-ceiling tool name (`get_email`, part of
// the permanent read-only default — see mcp-export.spec.ts above) plus
// fictional tool names that cannot be valid under ANY future ceiling. This
// also means these tests do not hardcode a tool COUNT anywhere, so a
// concurrent change to the export ceiling (e.g. removing `update_memory`)
// cannot break them.
// =============================================================================

test('MCP export: an explicit whitelist keeps an in-ceiling tool and silently drops one outside it', async () => {
  const ctx = await launchApp('mailcopilot-e2e-mcp-whitelist-narrow-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0, ['get_email', 'zzz_definitely_not_a_real_tool_e2e']) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    const initResp = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-narrow', version: '1.0' },
    })
    const sessionId = initResp.headers['mcp-session-id']

    const toolsResp = await mcpCall(baseUrl, token, 'tools/list', {}, sessionId)
    const tools = toolsResp.body.result?.tools ?? []
    const toolNames = tools.map((t: { name: string }) => t.name)

    // Only the in-ceiling tool survives — the fictional name is dropped, not
    // registered and not substituted with anything else.
    expect(toolNames).toEqual(['get_email'])

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})

test('MCP export: a whitelist with no valid entries yields zero tools, never the read-only default', async () => {
  const ctx = await launchApp('mailcopilot-e2e-mcp-whitelist-empty-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0, ['zzz_fake_tool_one_e2e', 'zzz_fake_tool_two_e2e']) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    const initResp = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-empty', version: '1.0' },
    })
    const sessionId = initResp.headers['mcp-session-id']

    const toolsResp = await mcpCall(baseUrl, token, 'tools/list', {}, sessionId)
    const tools = toolsResp.body.result?.tools ?? []

    // The caller asked for something specific and none of it was allowed.
    // Falling back to the twelve-tool read-only default here would be a
    // silent widening of what an external client can reach.
    expect(tools).toEqual([])

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})

test('MCP export: apply_mail_action without a preceding preview is rejected by the same gate as chat', async () => {
  const ctx = await launchApp('mailcopilot-e2e-mcp-apply-gate-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0, ['preview_mail_action', 'apply_mail_action']) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    const initResp = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-apply-gate', version: '1.0' },
    })
    const sessionId = initResp.headers['mcp-session-id']

    const toolsResp = await mcpCall(baseUrl, token, 'tools/list', {}, sessionId)
    const toolNames = (toolsResp.body.result?.tools ?? []).map((t: { name: string }) => t.name)
    expect(toolNames).toContain('preview_mail_action')
    expect(toolNames).toContain('apply_mail_action')

    // No preview_mail_action call precedes this — the export transport must
    // hold the exact same preview/apply pairing gate as the chat path
    // (§2.158). A previewId that was never issued has no confirmation token
    // to steal, so this must reject with `preview_not_found`, not execute
    // anything and not fail with some unrelated error.
    const applyResp = await mcpCall(baseUrl, token, 'tools/call', {
      name: 'apply_mail_action',
      arguments: { previewId: 'e2e-nonexistent-preview-id', confirmation_token: 'e2e-bogus-token' },
    }, sessionId)
    expect(applyResp.status).toBe(200)
    const payload = JSON.parse(toolResultText(applyResp)) as { ok: boolean; reason?: string }
    expect(payload.ok).toBe(false)
    expect(payload.reason).toBe('preview_not_found')

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})

test('MCP export: an 11th session is rejected once MAX_SESSIONS (10) is reached', async () => {
  const ctx = await launchApp('mailcopilot-e2e-mcp-sessions-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const startResult = await page.evaluate(async () => {
      return await (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } })
        .api.invoke('mcpExport:start', 0) as { ok: boolean; port: number; token: string }
    })
    const { port, token } = startResult
    const baseUrl = `http://127.0.0.1:${port}/mcp`

    // Sessions are opened SEQUENTIALLY, not via Promise.all(): the server's
    // MAX_SESSIONS guard reads `this.sessions.size` synchronously at request
    // entry, but the session is only registered later, inside the async
    // `transport.handleRequest()` call (`onsessioninitialized`). Firing 11
    // truly concurrent requests would let several of them read the guard
    // before any had registered, racing past the limit — that would be a bug
    // in a naive concurrent client, not evidence about the server's own
    // limit. Awaiting each open in turn deterministically proves "10
    // already-open sessions block an 11th", which is what MAX_SESSIONS
    // actually promises.
    const sessionIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const resp = await mcpCall(baseUrl, token, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: `e2e-session-${i}`, version: '1.0' },
      })
      expect(resp.status).toBe(200)
      const sid = resp.headers['mcp-session-id']
      expect(sid).toBeTruthy()
      sessionIds.push(sid)
    }
    expect(new Set(sessionIds).size).toBe(10)

    const eleventh = await mcpCall(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-session-11', version: '1.0' },
    })
    expect(eleventh.status).toBe(429)
    expect(eleventh.headers['mcp-session-id']).toBeUndefined()

    await page.evaluate(async () => {
      await (window as unknown as { api: { invoke: (ch: string) => Promise<unknown> } }).api.invoke('mcpExport:stop')
    })
  } finally {
    await cleanupApp(ctx)
  }
})
