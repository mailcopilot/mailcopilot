import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * §2.82 iter2 — source-level pins for telemetry call sites whose PII boundary
 * cannot be asserted from behaviour without standing up a large harness.
 *
 * These are tripwires, not a substitute for the behavioural tests: the real
 * coverage for the Sent-copy diag lives in services/sentCopyFailure.test.ts and
 * main.sentCopyAppend.test.ts, for the OAuth paths in microsoftOAuth.test.ts and
 * services/outlookOAuthService.test.ts, and for the collection gate in
 * metrics.test.ts. What these pins add is a cheap alarm when a future edit
 * re-introduces the exact shape that leaked, in a file whose call site is
 * otherwise expensive to reach.
 */

function read(rel: string): string {
  return readFileSync(resolve(__dirname, rel), 'utf8')
}

describe('§2.82 iter2 finding 4 — the AI chat span goes through the collection gate', () => {
  const src = read('services/ai.ts')

  it('opens ai.chat through startMetricSpan, not the raw SDK helper', () => {
    expect(src).toMatch(/startMetricSpan\(\s*'ai\.chat'/)
  })

  it('makes no direct startInactiveSpan call anywhere in the AI service', () => {
    // A direct call bypasses `isTelemetryCollectionAllowed()` and the
    // `parentSpan: null` sampling guard. The identifier may still appear in a
    // `ReturnType<typeof startInactiveSpan>` type position — that is a type,
    // not a collection point, so match on the invocation shape only.
    expect(src).not.toMatch(/startInactiveSpan\s*\(/)
  })

  it('gates the one direct sentryLogger call on the collection gate', () => {
    const idx = src.indexOf("sentryLogger.info('AI chat completed'")
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(Math.max(0, idx - 200), idx)).toContain('isTelemetryCollectionAllowed()')
  })
})

describe('§2.82 iter2 finding 1 (audit) — MCP connection failures carry no user text', () => {
  const src = read('services/mcpClient.ts')

  it('never passes the user-typed connection name or the renderer-supplied id to Sentry', () => {
    // Both are free text: `name` is typed in the Add-connection form, `id` is
    // whatever the renderer sent with the save payload.
    const captureCalls = [...src.matchAll(/captureException\(([\s\S]{0,400}?)\n\s*\)/g)]
    expect(captureCalls.length).toBeGreaterThanOrEqual(2)
    for (const [, body] of captureCalls) {
      expect(body).not.toContain('config.name')
      expect(body).not.toContain('config.id')
      expect(body).not.toContain('connectionName')
    }
  })

  it('captures a synthetic error rather than the transport-authored one', () => {
    expect(src).toMatch(/captureException\(\s*\n\s*new Error\(`mcp_transport_error/)
    expect(src).toMatch(/captureException\(\s*\n\s*new Error\(`mcp_connect_failed/)
  })
})

describe('§2.82 iter2 finding 3 — settings:save preserves the persisted telemetry flag', () => {
  const src = read('main.ts')

  it('hands the About-toggle helper the RAW persisted value', () => {
    // Raw, not `current.sentryEnabled`: the parsed value cannot tell "never
    // written" from "explicitly false" once a schema default fills it in, and
    // that distinction is what stops the consent migration from reading main's
    // own clamp as a user's refusal.
    //
    // iter4 (security finding 1): the call site is now the origin-aware
    // `applyAboutToggleFromOrigin` — the persisted value is passed through it
    // unchanged, and the rejected-enable branch depends on it too.
    expect(src).toMatch(/getRawPersistedSettings\(\)\?\.sentryEnabled/)
    const idx = src.indexOf('applyAboutToggleFromOrigin(')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(idx, idx + 260)).toContain('persistedSentryEnabled')
  })
})
