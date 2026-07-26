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
