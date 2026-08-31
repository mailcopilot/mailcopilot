import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({} as Record<string, unknown>)),
  appendAiActionLog: vi.fn(),
  recordEvent: vi.fn(),
}))

// Mock ai.ts to avoid loading the entire AI module
vi.mock('./ai', () => ({
  createMailMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  })),
}))

// §2.158 — `mcpExport.ts` now pulls in `aiEgressPolicy` / `aiInternetGate`
// (for the gates) and `packages/net/config` (for the export ceiling + the
// egress policy setting). Those transitively reach `packages/db`, which opens
// SQLite at module load — fatal under the CI `unit-tests` job where
// better-sqlite3 is built for the Electron ABI. Stub the two symbols they
// actually use; the gate modules themselves stay REAL, because the point of
// the parity test below is that the export path and the chat path run the
// same code.
vi.mock('../../packages/db', () => ({
  deleteAccountData: vi.fn(),
  appendAiActionLog: mocks.appendAiActionLog,
}))
vi.mock('../metrics', () => ({ recordEvent: mocks.recordEvent }))

// Partial mock: only `getSettings` is stubbed (tests drive `aiEgressPolicy`
// through it). Everything else — including the real `EXPORTABLE_MCP_TOOLS`
// ceiling and `rendererWritableSettingsSchema` — comes from the real module.
vi.mock('../../packages/net/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/net/config')>()),
  getSettings: mocks.getSettings,
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

import {
  McpExportServer,
  DEFAULT_EXPORT_WHITELIST,
  ALL_EXPORTABLE_TOOLS,
  resolveExportWhitelist,
  buildExportGates,
  __intersectWithExportCeilingForTest,
} from './mcpExport'
import { createMailMcpServer } from './ai'
import { shouldDenyEgress, type EgressGate } from './aiEgressPolicy'
import {
  deniedToolResult,
  interceptInternetTool,
  setInternetToolPendingBroadcaster,
  type InternetGate,
} from './aiInternetGate'
import { rendererWritableSettingsSchema } from '../../packages/net/config'

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
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'default-deny', aiProvider: 'anthropic-api' })
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
    expect(createMailMcpServer).toHaveBeenCalledWith(
      expect.any(Set), expect.any(Object), expect.any(Object),
    )
  })

  it('passes whitelist to createMailMcpServer', async () => {
    const custom = ['get_email', 'search_emails']
    await server.start(0, custom)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(vi.mocked(createMailMcpServer).mock.calls[0]?.[0]).toEqual(new Set(custom))
  })

  it('uses default whitelist when none provided', async () => {
    await server.start(0)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(vi.mocked(createMailMcpServer).mock.calls[0]?.[0]).toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
  })

  // §2.158 — the whole point: a tool name that is not in the ceiling must not
  // reach `createMailMcpServer`, whatever the settings say. `call_external_tool`
  // is the concrete escalation this closes — it is the un-gated external-MCP
  // egress bridge, and before this change any string in
  // `Settings.mcpExportWhitelist` was registered verbatim.
  it('drops whitelist entries outside ALL_EXPORTABLE_TOOLS before registering tools', async () => {
    await server.start(0, ['get_email', 'call_external_tool', 'list_external_tools', 'not_a_tool'])
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    expect(vi.mocked(createMailMcpServer).mock.calls[0]?.[0]).toEqual(new Set(['get_email']))
  })

  // `update_memory` left the ceiling: it overwrites persisted AI memory in
  // place, with no preview/apply pair and no confirmation token, and on THIS
  // path there is no user turn behind the call at all — an external client
  // authors it. Poisoned memory then re-enters every later answer and summary,
  // so `wrapUntrusted()` bounds the damage but does not undo it.
  //
  // Asserted at the REGISTRATION boundary, not only on the constant: the
  // constant is the declaration, this is the thing that would actually hurt.
  // Both entry points are covered, because they are separate arguments to the
  // same call and a regression could restore either one alone.
  it('never registers update_memory when a client explicitly asks for it', async () => {
    await server.start(0, ['get_email', 'update_memory'])
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    const registered = vi.mocked(createMailMcpServer).mock.calls[0]?.[0] as Set<string>
    expect(registered.has('update_memory')).toBe(false)
    expect(registered).toEqual(new Set(['get_email']))
  })

  it('never registers update_memory under the default whitelist', async () => {
    await server.start(0)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    const registered = vi.mocked(createMailMcpServer).mock.calls[0]?.[0] as Set<string>
    expect(registered.has('update_memory')).toBe(false)
  })

  // §2.158 — the export path must not be more permissive than the chat path.
  // Before this change the gates were `undefined`, i.e. no policy at all.
  it('passes the egress and internet gates to createMailMcpServer', async () => {
    await server.start(0)
    await authRequest(server, {
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
    const call = vi.mocked(createMailMcpServer).mock.calls[0]
    const egressGate = call?.[1] as EgressGate | undefined
    const internetGate = call?.[2] as InternetGate | undefined
    expect(egressGate).toBeDefined()
    expect(internetGate).toBeDefined()
    expect(shouldDenyEgress(egressGate!)).toBe(true)
    expect(internetGate!.consentForTurn).toBe('denied')
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

  // §2.158 — the external-MCP bridge is an egress surface and belongs to the
  // chat path, where a human is present to answer the §3.10 P2 consent prompt.
  // If a future change adds it here, the gates below become load-bearing
  // instead of defence-in-depth — hence the explicit assertion.
  it('ALL_EXPORTABLE_TOOLS excludes the external-MCP egress bridge', () => {
    expect(ALL_EXPORTABLE_TOOLS).not.toContain('list_external_tools')
    expect(ALL_EXPORTABLE_TOOLS).not.toContain('call_external_tool')
  })

  // The unpaired-mutating-tool exception is `create_draft` ALONE. A draft is
  // inert until a human sends it (no-send-ever is a separate invariant);
  // memory is not inert — it is read back into later prompts. Anyone tempted
  // to restore `update_memory` "for symmetry" must ship the preview/apply pair
  // with it, and this assertion is where that decision surfaces.
  it('ALL_EXPORTABLE_TOOLS excludes update_memory (memory writes are chat-only)', () => {
    expect(ALL_EXPORTABLE_TOOLS).not.toContain('update_memory')
    expect(ALL_EXPORTABLE_TOOLS).toContain('create_draft')
  })

  it('DEFAULT_EXPORT_WHITELIST excludes update_memory', () => {
    expect(DEFAULT_EXPORT_WHITELIST as readonly string[]).not.toContain('update_memory')
  })
})

describe('resolveExportWhitelist (§2.158 ceiling)', () => {
  it('falls back to the read-only default when no whitelist is given', () => {
    expect(resolveExportWhitelist()).toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
    expect(resolveExportWhitelist(undefined)).toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
  })

  // Backward compatibility: existing external clients connected against the
  // 12-tool default must keep seeing exactly those 12 tools.
  it('passes DEFAULT_EXPORT_WHITELIST through unchanged', () => {
    expect(resolveExportWhitelist([...DEFAULT_EXPORT_WHITELIST]))
      .toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
    expect(resolveExportWhitelist([...DEFAULT_EXPORT_WHITELIST]).size)
      .toBe(DEFAULT_EXPORT_WHITELIST.length)
  })

  it('keeps every tool inside the ceiling, including the preview/apply pairs', () => {
    expect(resolveExportWhitelist([...ALL_EXPORTABLE_TOOLS]))
      .toEqual(new Set(ALL_EXPORTABLE_TOOLS))
  })

  it('drops arbitrary strings instead of registering them', () => {
    expect(resolveExportWhitelist(['get_email', 'totally_made_up', '', 'query_db']))
      .toEqual(new Set(['get_email', 'query_db']))
  })

  it('drops de-listed direct mutating tools', () => {
    expect(resolveExportWhitelist(['send_email', 'mail_action', 'delete_mail_rule']))
      .toEqual(new Set())
  })

  it('drops the external-MCP bridge tools', () => {
    expect(resolveExportWhitelist(['list_external_tools', 'call_external_tool']))
      .toEqual(new Set())
  })

  // An explicit-but-fully-invalid list must NOT fall back to the default: the
  // caller asked for something specific and none of it was allowed. Falling
  // back would silently WIDEN the surface the caller requested.
  it('yields an empty set (not the default) when every entry is rejected', () => {
    const resolved = resolveExportWhitelist(['nope', 'call_external_tool'])
    expect(resolved.size).toBe(0)
    expect(resolved).not.toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
  })

  it('tolerates non-string entries from a hand-edited config', () => {
    expect(resolveExportWhitelist(['get_email', null as unknown as string, 42 as unknown as string]))
      .toEqual(new Set(['get_email']))
  })

  it('drops update_memory from an explicit list', () => {
    expect(resolveExportWhitelist(['get_email', 'update_memory']))
      .toEqual(new Set(['get_email']))
    expect(resolveExportWhitelist(['update_memory'])).toEqual(new Set())
  })

  it('does not resolve update_memory from the default path either', () => {
    expect(resolveExportWhitelist().has('update_memory')).toBe(false)
  })
})

// The default set is not a trusted shortcut. It used to be returned verbatim,
// so the ceiling was enforced on ONE of the two branches: the day a tool is
// added to the default and forgotten in `EXPORTABLE_MCP_TOOLS` (or removed
// from the ceiling and forgotten in the default), that branch would export it
// anyway — at startup and on every call without an explicit list.
describe('the default whitelist passes through the ceiling, like any other list', () => {
  it('resolves identically whether the default is implicit or passed explicitly', () => {
    expect(resolveExportWhitelist()).toEqual(resolveExportWhitelist([...DEFAULT_EXPORT_WHITELIST]))
  })

  it('every default entry survives the intersection (no accidental self-drop)', () => {
    expect(resolveExportWhitelist().size).toBe(DEFAULT_EXPORT_WHITELIST.length)
    for (const tool of DEFAULT_EXPORT_WHITELIST) {
      expect(ALL_EXPORTABLE_TOOLS).toContain(tool)
    }
  })

  // The regression this fix is really about: plant out-of-ceiling names in a
  // SYNTHETIC default and watch them get dropped. The production default
  // cannot carry one (`readonly ExportableMcpTool[]` — it would not compile),
  // which is exactly why the runtime half needs a seam to be exercised
  // through: a guarantee nobody can test is a guarantee nobody notices losing.
  it('drops an out-of-ceiling entry planted in the default set', () => {
    const synthetic = [
      ...DEFAULT_EXPORT_WHITELIST,
      'update_memory',       // de-listed by this change
      'call_external_tool',  // egress bridge, never exportable
      'send_email',          // direct mutating variant
      'brand_new_tool',      // simply unknown
    ]
    expect(__intersectWithExportCeilingForTest(synthetic))
      .toEqual(new Set(DEFAULT_EXPORT_WHITELIST))
  })

  it('drops non-string junk in the default position too', () => {
    expect(__intersectWithExportCeilingForTest([null, 42, undefined, 'get_email']))
      .toEqual(new Set(['get_email']))
  })
})

describe('buildExportGates (§2.158 egress parity with the chat path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setInternetToolPendingBroadcaster(null)
  })

  afterEach(() => {
    setInternetToolPendingBroadcaster(null)
  })

  it('never claims per-request consent — an external client has no turn to consent in', () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'allow', aiProvider: 'openai-api' })
    expect(buildExportGates().egressGate.perRequestConsent).toBe(false)
  })

  for (const policy of ['default-deny', 'ask'] as const) {
    it(`denies egress under the '${policy}' policy`, () => {
      mocks.getSettings.mockReturnValue({ aiEgressPolicy: policy, aiProvider: 'anthropic-api' })
      const { egressGate, internetGate } = buildExportGates()
      expect(shouldDenyEgress(egressGate)).toBe(true)
      expect(internetGate.consentForTurn).toBe('denied')
    })
  }

  it("mirrors the chat pre-seed under the 'allow' policy", () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'allow', aiProvider: 'anthropic-api' })
    const { egressGate, internetGate } = buildExportGates()
    expect(shouldDenyEgress(egressGate)).toBe(false)
    expect(internetGate.consentForTurn).toBe('approved')
  })

  // §2.218 — attribution must be EXPLICIT, never borrowed from Settings. The
  // old code read `settings.aiProvider ?? 'subscription'`: it labelled an
  // external client's egress with an AI provider that issued no request, and
  // after the provider removal the fallback would have named an id with no
  // registered adapter. Both directions are pinned here: a configured provider
  // does not leak into the label, and an UNCONFIGURED one neither substitutes a
  // provider nor refuses the session (MCP export is routinely used by people
  // running no in-app AI provider at all).
  it('attributes the session to mcp-export, not to the configured AI provider', () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'allow', aiProvider: 'openai-api' })
    expect(buildExportGates().internetGate.provider).toBe('mcp-export')
  })

  it('builds a usable session when NO AI provider is configured', () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'allow' })
    const { internetGate } = buildExportGates()
    expect(internetGate.provider).toBe('mcp-export')
    expect(internetGate.consentForTurn).toBe('approved')
  })

  it('coerces a missing / garbage policy to default-deny', () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'wide-open' })
    expect(shouldDenyEgress(buildExportGates().egressGate)).toBe(true)
    mocks.getSettings.mockReturnValue({})
    expect(shouldDenyEgress(buildExportGates().egressGate)).toBe(true)
  })

  it('reads settings per session, so a policy flip needs no server restart', () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'allow' })
    expect(buildExportGates().internetGate.consentForTurn).toBe('approved')
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'default-deny' })
    expect(buildExportGates().internetGate.consentForTurn).toBe('denied')
  })

  // The acceptance criterion: an external client calling `call_external_tool`
  // under a denying policy gets BYTE-FOR-BYTE the refusal the chat path emits.
  // `ai.ts` returns `JSON.stringify(deniedToolResult('call_external_tool'))`
  // from the interceptor branch; the golden literal below is that payload, so
  // this test fails if either side drifts.
  //
  // The gate under test is the one the export server ACTUALLY handed to
  // `createMailMcpServer` (captured from the call), not a locally rebuilt
  // `buildExportGates()` result — otherwise a server that wires up a gate of
  // its own would sail through.
  //
  // Honest limits of this test, so nobody reads more into it than it proves:
  //   - `./ai` is mocked here, so this does NOT prove that ai.ts's registered
  //     handler still routes through `interceptInternetTool` /
  //     `deniedToolResult`. That wiring is asserted against the real handler in
  //     `ai.test.ts` ('does not log raw serverId / toolName on
  //     call_external_tool denial path', which drives a real
  //     `createMailMcpServer` registration and asserts the blocked payload).
  //   - It cannot be driven end-to-end at all today: `call_external_tool` sits
  //     OUTSIDE `ALL_EXPORTABLE_TOOLS`, so the export server never registers
  //     that handler. The gate is defence-in-depth for the day someone puts the
  //     bridge back into the ceiling — which is exactly why it is asserted on
  //     the gate rather than on a call that cannot happen.
  it('hands over a gate that refuses call_external_tool with the exact chat-path payload', async () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'default-deny', aiProvider: 'anthropic-api' })

    const server = new McpExportServer()
    let internetGate: InternetGate | undefined
    try {
      await server.start(0)
      await authRequest(server, {
        method: 'POST',
        path: '/mcp',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }))
      internetGate = vi.mocked(createMailMcpServer).mock.calls[0]?.[2] as InternetGate | undefined
    } finally {
      await server.stop()
    }
    expect(internetGate).toBeDefined()

    const decision = await interceptInternetTool({
      gate: internetGate!,
      toolName: 'mcp__mailcopilot__call_external_tool',
      toolInput: { serverId: 'evil', toolName: 'exfiltrate', arguments: {} },
    })
    expect(decision).toBe('denied')

    // Payload pin on the shared helper both paths serialize verbatim: ai.ts
    // returns `JSON.stringify(deniedToolResult('call_external_tool'))` from the
    // interceptor branch, so a reworded refusal on either side breaks here.
    const golden = JSON.stringify({
      blocked: true,
      reason: 'internet_tool_denied',
      message: 'User denied internet access for this tool call (call_external_tool). '
        + 'Do not retry this turn — the user has been informed and can grant access in the AI panel if needed. '
        + 'Continue without external data, or tell the user you cannot complete the request without internet access.',
    })
    expect(JSON.stringify(deniedToolResult('call_external_tool'))).toBe(golden)
  })

  // The refusal must be structural, not a 30-second modal raised at whoever
  // happens to be at the keyboard: an unattended background client could
  // otherwise spam consent prompts until one gets clicked.
  it('refuses without prompting the user', async () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'default-deny', aiProvider: 'anthropic-api' })
    const broadcaster = vi.fn()
    setInternetToolPendingBroadcaster(broadcaster)
    const { internetGate } = buildExportGates()

    const decision = await interceptInternetTool({
      gate: internetGate,
      toolName: 'mcp__mailcopilot__call_external_tool',
      toolInput: {},
    })

    expect(decision).toBe('denied')
    expect(broadcaster).not.toHaveBeenCalled()
    expect(internetGate.pending.size).toBe(0)
  })

  // The blocked attempt still lands in the append-only AI action log and in
  // telemetry — a refusal nobody can see is not an auditable boundary.
  it('records the blocked attempt in the audit log and telemetry', async () => {
    mocks.getSettings.mockReturnValue({ aiEgressPolicy: 'ask', aiProvider: 'gemini-api' })
    const { internetGate } = buildExportGates()

    await interceptInternetTool({
      gate: internetGate,
      toolName: 'mcp__mailcopilot__call_external_tool',
      toolInput: { serverId: 's', toolName: 't' },
    })

    expect(mocks.appendAiActionLog).toHaveBeenCalledTimes(1)
    expect(mocks.appendAiActionLog.mock.calls[0]?.[0]).toMatchObject({
      // §2.218 — attributed to the EXPORT SERVER, not to whatever AI provider
      // the user happens to have configured (here `gemini-api`, which issued no
      // request). The audit row must name who actually acted.
      provider: 'mcp-export',
      toolName: 'mcp__mailcopilot__call_external_tool',
      injectionBlocked: 1,
    })
    expect(mocks.recordEvent).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      outcome: 'denied',
    }))
  })
})

describe('mcpExportWhitelist settings schema (§2.158)', () => {
  it('accepts every tool inside the ceiling', () => {
    const result = rendererWritableSettingsSchema.safeParse({
      mcpExportWhitelist: [...ALL_EXPORTABLE_TOOLS],
    })
    expect(result.success).toBe(true)
  })

  it('accepts the default read-only whitelist', () => {
    expect(rendererWritableSettingsSchema.safeParse({
      mcpExportWhitelist: [...DEFAULT_EXPORT_WHITELIST],
    }).success).toBe(true)
  })

  it('rejects a tool name outside the ceiling', () => {
    expect(rendererWritableSettingsSchema.safeParse({
      mcpExportWhitelist: ['call_external_tool'],
    }).success).toBe(false)
    expect(rendererWritableSettingsSchema.safeParse({
      mcpExportWhitelist: ['get_email', 'send_email'],
    }).success).toBe(false)
    expect(rendererWritableSettingsSchema.safeParse({
      mcpExportWhitelist: ['whatever'],
    }).success).toBe(false)
  })

  // An empty array is a VALID setting, and it does not mean "no preference".
  // `undefined` (field absent) is the only value that yields the read-only
  // default; `[]` is an explicit "expose nothing" and resolves to a server with
  // zero tools. Pinning both halves here because the two are one keystroke
  // apart in Settings and only one of them widens the surface.
  it('accepts an empty list, which resolves to zero tools rather than the default', () => {
    expect(rendererWritableSettingsSchema.safeParse({ mcpExportWhitelist: [] }).success).toBe(true)

    expect(resolveExportWhitelist([]).size).toBe(0)
    expect(resolveExportWhitelist([])).toEqual(new Set())

    // …whereas an absent field is what maps to the 12-tool read-only default.
    expect(resolveExportWhitelist(undefined).size).toBe(DEFAULT_EXPORT_WHITELIST.length)
    expect(resolveExportWhitelist(undefined)).not.toEqual(resolveExportWhitelist([]))
  })
})
