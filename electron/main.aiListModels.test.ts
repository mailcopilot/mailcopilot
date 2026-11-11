import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_TS = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')
const PRELOAD_TS = readFileSync(resolve(__dirname, 'preload.ts'), 'utf8')
const ENV_DTS = readFileSync(resolve(__dirname, 'electron-env.d.ts'), 'utf8')

function handlerBody(channel: string): string {
  const start = MAIN_TS.indexOf(`handleIpc('${channel}'`)
  expect(start, `handler for ${channel} not found`).toBeGreaterThan(-1)
  return MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))
}

describe('ai:listModels channel', () => {
  const body = handlerBody('ai:listModels')

  it('is whitelisted in preload and typed for the renderer', () => {
    expect(PRELOAD_TS).toContain("'ai:listModels'")
    expect(ENV_DTS).toContain("'ai:listModels'")
  })

  it('validates the provider with the shared schema and the overrides with the destination schema', () => {
    expect(body).toContain('aiProviderSchema')
    expect(body).toContain('aiDestinationOverridesSchema.parse')
  })

  it('takes no key: the only parameters are the provider and the destination overrides', () => {
    expect(body).toMatch(/handleIpc\('ai:listModels', async \(event, providerRaw\?: unknown, settingsOverrides\?: unknown\) =>/)
    expect(body).not.toMatch(/apiKey|api_key|secret/i)
  })

  it('serves a fixed list under IS_E2E before any destination or network step', () => {
    const e2e = body.indexOf('if (IS_E2E)')
    expect(e2e).toBeGreaterThan(-1)
    expect(e2e).toBeLessThan(body.indexOf('ensureAiDestinationApproved('))
    expect(body).toContain('E2E_AI_MODEL_LIST')
  })
})
