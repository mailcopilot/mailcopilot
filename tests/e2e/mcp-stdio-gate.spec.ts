/**
 * §3.10 P0 regression suite for the renderer-to-local-RCE gate.
 *
 * Simulates a compromised renderer trying to:
 *   1. Flip `mcpEnableStdio` via `settings:save` (must be rejected).
 *   2. Save a stdio connection with an unapproved command (must be rejected).
 *   3. Connect a stdio connection without prior native-confirm approval
 *      (must be rejected).
 *
 * The native-confirm dialogs are user-interaction gates that e2e cannot
 * drive through Playwright (electron/dialog is out-of-process). We cover
 * the post-approval path via unit tests on `resolveConnectionApproval`
 * and by asserting the block happens in the correct place. The e2e scope
 * here is strictly "a renderer cannot bypass the gate on its own".
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT } from './helpers'

type InvokeFn = (ch: string, ...args: unknown[]) => Promise<unknown>

function getInvoke(page: import('@playwright/test').Page) {
  return (channel: string, ...args: unknown[]) =>
    page.evaluate(
      ([ch, a]: [string, unknown[]]) =>
        (window as unknown as { api: { invoke: InvokeFn } }).api.invoke(ch, ...a),
      [channel, args] as [string, unknown[]],
    )
}

test('§3.10 P0: renderer cannot flip mcpEnableStdio via settings:save', async () => {
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    // Baseline: stdio must start disabled.
    const before = await invoke('settings:get') as { mcpEnableStdio?: boolean }
    expect(before.mcpEnableStdio).not.toBe(true)

    // Compromised-renderer simulation: attempt to inject mcpEnableStdio: true.
    const resp = await invoke('settings:save', {
      mcpEnableStdio: true,
      theme: 'dark',
    }) as { ok: boolean; reason?: string; fields?: string[] }

    expect(resp.ok).toBe(false)
    expect(resp.reason).toBe('forbidden_field')
    expect(resp.fields).toContain('mcpEnableStdio')

    // State must NOT have mutated — neither theme nor stdio flag changed.
    const after = await invoke('settings:get') as { mcpEnableStdio?: boolean; theme?: string }
    expect(after.mcpEnableStdio).not.toBe(true)
    expect(after.theme).toBe(before.theme ?? 'light')
  } finally {
    await cleanupApp(ctx)
  }
})

test('§3.10 P0: mcp:saveConnection rejects commands outside the allowlist', async () => {
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    const resp = await invoke('mcp:saveConnection', {
      id: 'evil-stdio-conn',
      name: 'Malicious Local Tool',
      transport: 'stdio',
      command: '/tmp/attacker-binary',
      args: ['--extract', '/etc/passwd'],
      enabled: true,
      autoConnect: false,
    }) as { ok: boolean; reason?: string }

    expect(resp.ok).toBe(false)
    expect(resp.reason).toBe('unapproved_command')
  } finally {
    await cleanupApp(ctx)
  }
})

test('§3.10 P0: mcp:connect refuses stdio without native-confirm approval', async () => {
  // Explicitly drop the env flag so the only available approval source is
  // native-confirm, which we cannot drive from e2e.
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-', {
    MAILCOPILOT_ENABLE_STDIO_MCP: '',
  })
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    // Save a connection with an allowlisted command (npx). Save succeeds
    // but approvedSource is null until the user clicks through the native
    // dialog — which we don't do here.
    const saveResp = await invoke('mcp:saveConnection', {
      id: 'allowed-but-unapproved',
      name: 'Unapproved Npx',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@some/mcp-server'],
      enabled: true,
      autoConnect: false,
    }) as { ok: boolean }
    expect(saveResp.ok).toBe(true)

    // Attempt to connect — must be rejected because stdio is disabled globally
    // (no env flag, no native-confirm).
    const connectResp = await invoke('mcp:connect', 'allowed-but-unapproved') as { ok: boolean; reason?: string }
    expect(connectResp.ok).toBe(false)
    // Either 'env_disabled' (global stdio off) or 'not_approved' (connection
    // not approved) is acceptable — both prove the gate stopped the spawn.
    expect(['env_disabled', 'not_approved']).toContain(connectResp.reason)
  } finally {
    await cleanupApp(ctx)
  }
})

test('§3.10 P0 wave 2: mcp:saveConnection rejects forbidden env keys (NODE_OPTIONS RCE)', async () => {
  // BLOCKER-1 regression: a compromised renderer that got past the command
  // allowlist by choosing `node` cannot use the per-connection `env` record
  // to inject a loader hook. The save handler rejects on the denylist
  // before the payload is persisted or a dialog is shown.
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    const resp = await invoke('mcp:saveConnection', {
      id: 'env-poisoned-conn',
      name: 'Allowed Command With Poisoned Env',
      transport: 'stdio',
      command: 'node', // allowlisted
      args: ['./server.js'],
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
      enabled: true,
      autoConnect: false,
    }) as { ok: boolean; reason?: string; keys?: string[] }

    expect(resp.ok).toBe(false)
    expect(resp.reason).toBe('forbidden_env_key')
    expect(resp.keys).toContain('NODE_OPTIONS')
  } finally {
    await cleanupApp(ctx)
  }
})

test('§3.10 P0 wave 2: mcp:saveConnection rejects LD_PRELOAD and PATH shadow', async () => {
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-')
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    for (const key of ['LD_PRELOAD', 'PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONSTARTUP']) {
      const resp = await invoke('mcp:saveConnection', {
        id: 'poisoned-' + key,
        name: 'Poison ' + key,
        transport: 'stdio',
        command: 'node',
        env: { [key]: 'hostile-value' },
        enabled: true,
        autoConnect: false,
      }) as { ok: boolean; reason?: string; keys?: string[] }
      expect(resp.ok, `expected ${key} to be rejected`).toBe(false)
      expect(resp.reason).toBe('forbidden_env_key')
      expect(resp.keys).toContain(key)
    }
  } finally {
    await cleanupApp(ctx)
  }
})

test('§3.10 P0: env-flag mode allows allowlisted stdio commands to connect', async () => {
  // With the env flag set, the gate synthesizes an 'env' approval for every
  // stdio connection, so saving an allowlisted command and then connecting
  // should succeed up to the transport layer. (The actual npx spawn will
  // fail because the MCP server isn't installed, but that's a transport
  // error — what we care about is that the gate didn't block first.)
  const ctx = await launchApp('mailcopilot-mcp-stdio-gate-', {
    MAILCOPILOT_ENABLE_STDIO_MCP: '1',
  })
  try {
    const { page } = ctx
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const invoke = getInvoke(page)

    const saveResp = await invoke('mcp:saveConnection', {
      id: 'env-approved-conn',
      name: 'Env Approved',
      transport: 'stdio',
      // `node` is in the allowlist and guaranteed present in the Electron
      // bundle, so the spawn itself can actually start even if the MCP
      // protocol handshake fails later — we only need to see the gate pass.
      command: 'node',
      args: ['-e', 'setTimeout(()=>{},100)'],
      enabled: true,
      autoConnect: false,
    }) as { ok: boolean }
    expect(saveResp.ok).toBe(true)

    // Fire-and-forget: we don't care if connect succeeds or fails at the
    // protocol level. We only assert the gate didn't short-circuit with
    // `ok: false, reason: 'not_approved'`.
    const connectResp = await invoke('mcp:connect', 'env-approved-conn').catch((err: Error) => ({
      ok: false as const,
      reason: 'thrown' as const,
      message: err.message,
    })) as { ok: boolean; reason?: string }

    // Success OR a transport-level failure (not an approval block). A block
    // would surface as `{ ok: false, reason: 'not_approved' | 'env_disabled' | 'unapproved_command' }`.
    if (!connectResp.ok) {
      expect(['not_approved', 'env_disabled', 'unapproved_command']).not.toContain(connectResp.reason)
    }
  } finally {
    await cleanupApp(ctx)
  }
})
