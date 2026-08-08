/**
 * §2.119 / §2.121 — a source-level check on the one function `electron/services/ai.ts`
 * and `electron/services/aiDestination.ts` are required to agree on.
 *
 * WHY SOURCE, NOT BEHAVIOUR. `normalizeOpenAiBaseUrl` in ai.ts was rewritten to
 * delegate to `openAiBaseUrlForRequest` — see the comment on that export:
 * "SINGLE SOURCE OF TRUTH ... if this function and the one the requests are
 * built from could drift, 'the same destination' would be a claim about a
 * string rather than about where the key goes". The delegation and the
 * function it delegates to are BYTE-IDENTICAL in their normalisation rule
 * today (strip trailing slashes, strip a trailing `/v1`, default to
 * `https://api.openai.com`), which is exactly why a behavioural test cannot
 * tell "ai.ts imports the shared function" from "ai.ts kept its own copy that
 * happens to still agree" — any input produces the same output either way.
 * The coupling this guards is a FUTURE one: `openAiBaseUrlForRequest` gaining
 * a new normalisation rule (e.g. a second default endpoint, IDN handling)
 * while ai.ts's request-building path silently does not, at which point the
 * guard would approve a destination the request layer no longer builds the
 * same way. That can only be caught by asserting the delegation itself
 * exists, the same reasoning as `aiDestinationWiring.test.ts` for main.ts.
 *
 * ai.ts is a 10 000+ line module already imported by ai.test.ts, but
 * `normalizeOpenAiBaseUrl` is not exported (and this task may not export it —
 * test files only), so the function body is read from source, exactly as
 * aiDestinationWiring.test.ts reads electron/main.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const AI_TS = readFileSync(fileURLToPath(new URL('./ai.ts', import.meta.url)), 'utf8')

function functionSource(name: string): string {
  const start = AI_TS.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found in electron/services/ai.ts`).toBeGreaterThan(-1)
  const end = AI_TS.indexOf('\n}', start)
  expect(end, `closing brace of ${name} not found`).toBeGreaterThan(start)
  return AI_TS.slice(start, end)
}

describe('§2.119 normalizeOpenAiBaseUrl delegates instead of re-implementing', () => {
  const body = functionSource('normalizeOpenAiBaseUrl')

  it('imports the shared canonicaliser from ./aiDestination', () => {
    expect(AI_TS).toMatch(/import\s*\{[^}]*\bopenAiBaseUrlForRequest\b[^}]*\}\s*from\s*'\.\/aiDestination'/)
  })

  it('handles the refusal of an unusable stored endpoint instead of letting it escape a generator', () => {
    // `openAiBaseUrlForRequest` throws rather than concatenating onto a value
    // it cannot parse. Every other call site sits inside an error-classifying
    // try; `streamOpenAiChat` computes the base OUTSIDE its own try, so a bare
    // call there would unwind the async generator into the consumer.
    const start = AI_TS.indexOf('async function* streamOpenAiChat(')
    expect(start, 'streamOpenAiChat not found').toBeGreaterThan(-1)
    const call = AI_TS.indexOf('normalizeOpenAiBaseUrl(', start)
    const guardOpen = AI_TS.lastIndexOf('try {', call)
    expect(guardOpen, 'the base-URL call in streamOpenAiChat is not inside a try').toBeGreaterThan(start)
    expect(AI_TS.slice(guardOpen, AI_TS.indexOf('\n\n', call))).toContain('UnusableAiEndpointError')
  })

  it('calls the shared function rather than duplicating its normalisation rule', () => {
    expect(body).toContain('openAiBaseUrlForRequest(')
    // The regression this guards: a re-implementation using the same regex
    // literals as before delegation existed, which would compile, pass every
    // existing behavioural test (the two are identical today) and silently
    // stop tracking future changes to the shared function.
    expect(body).not.toMatch(/\.replace\(/)
  })
})

describe('§2.121 the ProxyAgent log line is built through describeProxyForLog', () => {
  it('never interpolates the raw proxy URL into the log call', () => {
    const start = AI_TS.indexOf("logAI.info(`ProxyAgent created:")
    expect(start, 'ProxyAgent created log line not found').toBeGreaterThan(-1)
    const line = AI_TS.slice(start, AI_TS.indexOf('\n', start))
    expect(line).toContain('describeProxyForLog(')
    // The regression this guards: reverting to `${proxyUrl}` compiles, and the
    // sentinel-based behavioural test in ai.test.ts only runs the ONE call site
    // it knows about — a second log line built the old way elsewhere in the
    // file would not be caught by scanning logger calls for a specific sentinel
    // unless that exact code path is exercised.
    expect(line).not.toMatch(/\$\{proxyUrl\}/)
  })
})
