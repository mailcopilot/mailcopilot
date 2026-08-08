/**
 * §2.119 — what counts as "the same destination".
 *
 * Every case here is a decision about whether a human is asked before the
 * user's AI API key starts travelling somewhere else: a false "same" is a
 * silent exfiltration path, a false "different" trains the user to click
 * through the prompt that protects them. Both directions are asserted.
 */
import { describe, it, expect } from 'vitest'
import {
  openAiBaseUrlForRequest,
  canonicalizeAiDestinationUrl,
  resolveAiDestination,
  resolveRequestedAiDestination,
  applyAiDestinationOverrides,
  applyAiDestinationDecision,
  planAiDestinationChanges,
  aiDestinationApprovalKey,
  aiDestinationOverridesSchema,
  isCleartextDestination,
  isOpenAiCompatibleProvider,
  describeEffectiveAiEndpoint,
  withEffectiveProvider,
  parseAiEndpointBase,
  UnusableAiEndpointError,
  DEFAULT_OPENAI_BASE_URL,
  MAX_AI_DESTINATION_LENGTH,
} from './aiDestination'

describe('openAiBaseUrlForRequest', () => {
  // The shape the request layer has always used. ai.ts now delegates here, so
  // this table is what stops the guard's idea of the address from drifting
  // away from the address the key is actually sent to.
  it.each([
    [undefined, DEFAULT_OPENAI_BASE_URL],
    ['', DEFAULT_OPENAI_BASE_URL],
    ['   ', DEFAULT_OPENAI_BASE_URL],
    ['https://llm.example.tld', 'https://llm.example.tld'],
    ['https://llm.example.tld/', 'https://llm.example.tld'],
    ['https://llm.example.tld///', 'https://llm.example.tld'],
    ['https://llm.example.tld/v1', 'https://llm.example.tld'],
    ['https://llm.example.tld/v1/', 'https://llm.example.tld'],
    ['  https://llm.example.tld/v1  ', 'https://llm.example.tld'],
    ['https://llm.example.tld/api/v1', 'https://llm.example.tld/api'],
    // Parsed, not string-chopped: a default port and host case fold away here
    // exactly as they do in the identity, because they ARE the identity now.
    ['HTTPS://LLM.Example.TLD:443/v1', 'https://llm.example.tld'],
    ['http://llm.lan:8080/', 'http://llm.lan:8080'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(openAiBaseUrlForRequest(raw)).toBe(expected)
  })

  /**
   * THE TRANSPORT INVARIANT. The address the guard approved must be the literal
   * prefix of the URL that is requested — otherwise "this destination was
   * confirmed" is a claim about one string while the key travels to another.
   *
   * The defect this pins: the identity came from `new URL(...)`, which DROPS a
   * fragment, while the request came from concatenation onto the raw value. So
   * `https://gw/tenant#x` and `https://gw/tenant` were one approved identity,
   * and the requests they build are `https://gw/tenant` (nothing after `#`
   * leaves the machine) and `https://gw/tenant/v1/models` — different resources
   * on a path-routed gateway, with no second confirmation.
   */
  const CORPUS = [
    undefined, '', '   ',
    'https://llm.example.tld', 'https://llm.example.tld/', 'https://llm.example.tld/v1',
    'https://llm.example.tld/v1/', 'https://llm.example.tld/api/v1', 'HTTPS://LLM.Example.TLD:443',
    'http://llm.lan:8080', 'http://127.0.0.1:1234/v1', 'http://[::1]:11434',
    'https://user:pw@gateway.example/tenant', 'https://gateway.example/tenant',
    'https://llm.example.tld:8443/base/', 'https://xn--80ak6aa92e.example', 'https://пример.example',
  ]

  it.each(CORPUS)('identity === requestBase, so the approved value IS the requested prefix (%s)', raw => {
    const resolved = resolveAiDestination('aiOpenAiBaseUrl', raw)
    expect(resolved.kind).toBe('url')
    if (resolved.kind !== 'url') throw new Error('unreachable')
    const requestBase = openAiBaseUrlForRequest(raw)
    expect(resolved.identity).toBe(requestBase)
    // And the URL that is actually built parses back to that same origin+path.
    const built = new URL(`${requestBase}/v1/models`)
    expect(built.href).toBe(`${requestBase}/v1/models`)
    expect(built.hash).toBe('')
    expect(built.search).toBe('')
    expect(`${built.protocol}//${built.host}${built.pathname}`.startsWith(
      `${built.protocol}//${built.host}${new URL(requestBase).pathname}`.replace(/\/$/, ''),
    )).toBe(true)
  })

  it('two values that share an identity build the SAME request URL', () => {
    const a = 'https://gateway.example/tenant'
    const b = 'https://GATEWAY.example:443/tenant/v1/'
    expect(resolveAiDestination('aiOpenAiBaseUrl', a)).toEqual(resolveAiDestination('aiOpenAiBaseUrl', b))
    expect(openAiBaseUrlForRequest(a)).toBe(openAiBaseUrlForRequest(b))
  })

  it.each([
    ['a fragment', 'https://gateway.example/tenant#x'],
    ['an empty-looking fragment that still hides text', 'https://gateway.example/tenant#/v1/models'],
    ['a query string', 'https://gateway.example/tenant?a=b'],
    ['a non-http scheme', 'ftp://gateway.example/tenant'],
    ['garbage', 'not a url'],
    ['a scheme-relative address', '//gateway.example/tenant'],
  ])('refuses %s rather than reinterpreting it', (_label, raw) => {
    expect(parseAiEndpointBase(raw)).toBeNull()
    expect(resolveAiDestination('aiOpenAiBaseUrl', raw)).toEqual({ kind: 'invalid' })
    expect(() => openAiBaseUrlForRequest(raw)).toThrow(UnusableAiEndpointError)
  })

  it('keeps credentials in the requested URL and out of the shown one', () => {
    const raw = 'https://user:pw@gateway.example/tenant'
    const parsed = parseAiEndpointBase(raw)
    expect(parsed?.requestBase).toBe('https://user:pw@gateway.example/tenant')
    expect(parsed?.identity).toBe(parsed?.requestBase)
    expect(parsed?.display).toBe('https://gateway.example:443/tenant')
    expect(parsed?.display).not.toContain('pw')
    // A credential change is a change of the requested URL, so it is a change
    // of identity too — the guard asks rather than silently sending different
    // credentials to the same host.
    expect(parseAiEndpointBase('https://user:other@gateway.example/tenant')?.identity)
      .not.toBe(parsed?.identity)
  })

  it('refuses an address longer than the cap instead of truncating it into a request', () => {
    const long = `https://h.example/${'a'.repeat(MAX_AI_DESTINATION_LENGTH)}`
    expect(parseAiEndpointBase(long)).toBeNull()
    expect(() => openAiBaseUrlForRequest(long)).toThrow(UnusableAiEndpointError)
  })
})

describe('canonicalizeAiDestinationUrl', () => {
  it('treats a default port, host case and a trailing slash as the same address', () => {
    const plain = canonicalizeAiDestinationUrl('https://llm.example.tld')
    expect(canonicalizeAiDestinationUrl('HTTPS://LLM.Example.TLD:443/')?.identity)
      .toBe(plain?.identity)
  })

  it('keeps a non-default port, the scheme, the path and the query as part of the identity', () => {
    const base = canonicalizeAiDestinationUrl('https://llm.example.tld')!.identity
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld:8443')!.identity).not.toBe(base)
    expect(canonicalizeAiDestinationUrl('http://llm.example.tld')!.identity).not.toBe(base)
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld/proxy')!.identity).not.toBe(base)
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld?tenant=2')!.identity).not.toBe(base)
    // A different host is never the same address, however similar it looks.
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld.evil.tld')!.identity).not.toBe(base)
  })

  it('drops the fragment, which is never sent to a server', () => {
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld/#x')!.identity)
      .toBe(canonicalizeAiDestinationUrl('https://llm.example.tld')!.identity)
  })

  it('shows the port explicitly even when it is the scheme default', () => {
    expect(canonicalizeAiDestinationUrl('https://llm.example.tld')!.display)
      .toBe('https://llm.example.tld:443')
    expect(canonicalizeAiDestinationUrl('http://proxy.corp')!.display)
      .toBe('http://proxy.corp:80')
  })

  it('serialises a Unicode host as punycode, so the prompt cannot show a homograph', () => {
    const cyrillic = canonicalizeAiDestinationUrl('https://пример.рф')!
    expect(cyrillic.display).toBe('https://xn--e1afmkfd.xn--p1ai:443')
    expect(cyrillic.identity).not.toContain('пример')
  })

  it('drops embedded credentials from both forms', () => {
    const withCreds = canonicalizeAiDestinationUrl('http://user:hunter2@proxy.corp:3128')!
    expect(withCreds.display).toBe('http://proxy.corp:3128')
    expect(withCreds.identity).not.toContain('hunter2')
    // Same proxy, different credentials — not a change of recipient.
    expect(canonicalizeAiDestinationUrl('http://other:pw@proxy.corp:3128')!.identity)
      .toBe(withCreds.identity)
  })

  it('rejects anything that is not a usable http(s) address', () => {
    for (const raw of [
      'not a url',
      'llm.example.tld',
      'proxy.corp:3128',
      'file:///etc/passwd',
      'socks5://proxy.corp:1080',
      'javascript:alert(1)',
      'data:text/plain,x',
      '',
    ]) {
      expect(canonicalizeAiDestinationUrl(raw), raw).toBeNull()
    }
  })

  it('rejects an absurdly long address instead of truncating it into the dialog', () => {
    const long = `https://llm.example.tld/${'a'.repeat(MAX_AI_DESTINATION_LENGTH)}`
    expect(canonicalizeAiDestinationUrl(long)).toBeNull()
  })

  // The bound is `raw.length > MAX_AI_DESTINATION_LENGTH`, not `>=` — the exact
  // edge is where an off-by-one would first show up (rejecting a legitimate
  // address, or accepting one byte more than the comment above promises).
  it('accepts an address at exactly the length cap, and rejects one byte over', () => {
    const prefix = 'https://llm.example.tld/'
    const atCap = prefix + 'a'.repeat(MAX_AI_DESTINATION_LENGTH - prefix.length)
    expect(atCap).toHaveLength(MAX_AI_DESTINATION_LENGTH)
    expect(canonicalizeAiDestinationUrl(atCap)).not.toBeNull()

    const overCap = atCap + 'a'
    expect(overCap).toHaveLength(MAX_AI_DESTINATION_LENGTH + 1)
    expect(canonicalizeAiDestinationUrl(overCap)).toBeNull()
  })

  it('cannot produce a display string carrying raw control characters', () => {
    // The URL parser strips tabs/newlines and percent-encodes the rest, so a
    // planted address cannot inject extra lines into the confirmation text.
    const injected = canonicalizeAiDestinationUrl('https://llm.example.tld/\n\nPress OK')
    expect(injected!.display).not.toMatch(/[\n\r\t]/)
  })
})

describe('resolveAiDestination', () => {
  it('resolves an unset base URL to the vendor default, not to "nothing"', () => {
    const unset = resolveAiDestination('aiOpenAiBaseUrl', undefined)
    expect(unset.kind).toBe('url')
    expect(resolveAiDestination('aiOpenAiBaseUrl', DEFAULT_OPENAI_BASE_URL)).toEqual(unset)
  })

  it('resolves an unset proxy to "direct"', () => {
    expect(resolveAiDestination('aiProxyUrl', undefined)).toEqual({ kind: 'direct' })
    expect(resolveAiDestination('aiProxyUrl', '   ')).toEqual({ kind: 'direct' })
  })

  it('reports an unusable value as invalid rather than guessing', () => {
    expect(resolveAiDestination('aiOpenAiBaseUrl', 'llm.example.tld').kind).toBe('invalid')
    expect(resolveAiDestination('aiProxyUrl', 'socks5://p:1080').kind).toBe('invalid')
  })
})

describe('planAiDestinationChanges', () => {
  const current = { aiOpenAiBaseUrl: 'https://llm.example.tld', aiProxyUrl: 'http://proxy.corp:3128' }

  it('sees no change when the same values are saved again', () => {
    expect(planAiDestinationChanges(current, { ...current })).toEqual([])
  })

  it('sees no change for values that only differ in a normalised way', () => {
    expect(planAiDestinationChanges(current, {
      aiOpenAiBaseUrl: 'HTTPS://LLM.Example.TLD:443/v1/',
      aiProxyUrl: 'http://proxy.corp:3128/',
    })).toEqual([])
  })

  it('sees no change when both are untouched on a fresh install', () => {
    expect(planAiDestinationChanges({}, {})).toEqual([])
    expect(planAiDestinationChanges({}, { aiOpenAiBaseUrl: DEFAULT_OPENAI_BASE_URL })).toEqual([])
  })

  it('reports a genuinely different endpoint', () => {
    const changes = planAiDestinationChanges(current, {
      ...current,
      aiOpenAiBaseUrl: 'https://collector.evil.tld',
    })
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('aiOpenAiBaseUrl')
    expect(changes[0].to).toMatchObject({ kind: 'url', display: 'https://collector.evil.tld:443' })
  })

  it('reports CLEARING a custom endpoint — the key would start going to the vendor', () => {
    const changes = planAiDestinationChanges(current, { ...current, aiOpenAiBaseUrl: undefined })
    expect(changes.map(c => c.field)).toEqual(['aiOpenAiBaseUrl'])
  })

  it('reports adding or replacing a proxy', () => {
    expect(planAiDestinationChanges({}, { aiProxyUrl: 'http://mitm.evil.tld:8080' })
      .map(c => c.field)).toEqual(['aiProxyUrl'])
    expect(planAiDestinationChanges(current, { ...current, aiProxyUrl: 'http://mitm.evil.tld:8080' })
      .map(c => c.field)).toEqual(['aiProxyUrl'])
  })

  it('does NOT report removing the proxy — that only takes a listener away', () => {
    expect(planAiDestinationChanges(current, { ...current, aiProxyUrl: undefined })).toEqual([])
    expect(planAiDestinationChanges(current, { ...current, aiProxyUrl: '' })).toEqual([])
  })

  it('reports both fields when both move', () => {
    const changes = planAiDestinationChanges(current, {
      aiOpenAiBaseUrl: 'https://collector.evil.tld',
      aiProxyUrl: 'http://mitm.evil.tld:8080',
    })
    expect(changes.map(c => c.field)).toEqual(['aiOpenAiBaseUrl', 'aiProxyUrl'])
  })

  it('leaves an unusable STORED value alone but reports an unusable NEW one', () => {
    const junk = { aiOpenAiBaseUrl: 'llm.example.tld' }
    expect(planAiDestinationChanges(junk, { ...junk })).toEqual([])
    const changes = planAiDestinationChanges(junk, { aiOpenAiBaseUrl: 'still not a url' })
    expect(changes).toHaveLength(1)
    expect(changes[0].to.kind).toBe('invalid')
  })
})

describe('aiDestinationApprovalKey', () => {
  it('scopes an approval to one field, so an approved endpoint is not an approved proxy', () => {
    const [endpoint] = planAiDestinationChanges({}, { aiOpenAiBaseUrl: 'http://host.tld:8080' })
    const [proxy] = planAiDestinationChanges({}, { aiProxyUrl: 'http://host.tld:8080' })
    expect(aiDestinationApprovalKey(endpoint)).not.toBe(aiDestinationApprovalKey(proxy))
  })
})

describe('resolveRequestedAiDestination', () => {
  const current = { aiOpenAiBaseUrl: 'https://llm.example.tld', aiProxyUrl: 'http://proxy.corp:3128' }

  it('keeps the stored value for a field the payload does not mention', () => {
    expect(resolveRequestedAiDestination({ theme: 'dark' }, current)).toEqual(current)
  })

  it('treats a present-but-undefined field as a request to clear it', () => {
    // The settings window sends `aiOpenAiBaseUrl: value || undefined`, so this
    // is how an emptied input arrives — `??` against the stored value would
    // silently wave the resulting move to the vendor default through.
    expect(resolveRequestedAiDestination({ aiOpenAiBaseUrl: undefined }, current))
      .toEqual({ aiOpenAiBaseUrl: undefined, aiProxyUrl: current.aiProxyUrl })
  })

  it('takes the requested value when the payload carries one', () => {
    expect(resolveRequestedAiDestination({ aiProxyUrl: 'http://mitm.evil.tld:8080' }, current))
      .toEqual({ aiOpenAiBaseUrl: current.aiOpenAiBaseUrl, aiProxyUrl: 'http://mitm.evil.tld:8080' })
  })

  it('ignores a non-string value and a non-object payload', () => {
    expect(resolveRequestedAiDestination({ aiProxyUrl: { toString: () => 'x' } }, current))
      .toEqual({ aiOpenAiBaseUrl: current.aiOpenAiBaseUrl, aiProxyUrl: undefined })
    expect(resolveRequestedAiDestination(null, current)).toEqual(current)
    expect(resolveRequestedAiDestination('nope', current)).toEqual(current)
  })
})

describe('aiDestinationOverridesSchema', () => {
  it('keeps a field sent as an explicit undefined as an own property', () => {
    // This is the whole reason the merge rule cannot be `??`: the parsed
    // payload REMEMBERS that the renderer asked for a clear, and any consumer
    // that only looks at the value cannot tell that apart from "not sent".
    const parsed = aiDestinationOverridesSchema.parse({ aiOpenAiBaseUrl: undefined })
    expect(Object.prototype.hasOwnProperty.call(parsed ?? {}, 'aiOpenAiBaseUrl')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(parsed ?? {}, 'aiProxyUrl')).toBe(false)
  })

  it('trims, and drops keys the renderer did not send', () => {
    expect(aiDestinationOverridesSchema.parse({ aiProxyUrl: '  http://proxy.corp:3128  ' }))
      .toEqual({ aiProxyUrl: 'http://proxy.corp:3128' })
    expect(aiDestinationOverridesSchema.parse(undefined)).toBeUndefined()
  })
})

describe('applyAiDestinationOverrides', () => {
  const current = { theme: 'dark', aiOpenAiBaseUrl: 'https://llm.example.tld', aiProxyUrl: undefined }

  it('writes exactly what resolveRequestedAiDestination judged, for every payload shape', () => {
    for (const raw of [
      undefined,
      {},
      { aiOpenAiBaseUrl: 'https://collector.evil.tld' },
      { aiOpenAiBaseUrl: undefined },
      { aiProxyUrl: undefined },
      { aiProxyUrl: 'http://mitm.evil.tld:8080' },
      { aiOpenAiBaseUrl: '' },
      { aiOpenAiBaseUrl: 42 },
      'nope',
    ]) {
      const judged = resolveRequestedAiDestination(raw, current)
      const used = applyAiDestinationOverrides(current, raw)
      expect(used.aiOpenAiBaseUrl, JSON.stringify(raw)).toBe(judged.aiOpenAiBaseUrl)
      expect(used.aiProxyUrl, JSON.stringify(raw)).toBe(judged.aiProxyUrl)
    }
  })

  it('leaves every other field of the settings object alone', () => {
    const used = applyAiDestinationOverrides(current, { aiProxyUrl: 'http://proxy.corp:3128' })
    expect(used.theme).toBe('dark')
    expect(used.aiOpenAiBaseUrl).toBe(current.aiOpenAiBaseUrl)
  })

  it('performs a clear the payload asked for, rather than keeping the stored value', () => {
    const used = applyAiDestinationOverrides(current, { aiOpenAiBaseUrl: undefined })
    expect(used.aiOpenAiBaseUrl).toBeUndefined()
    expect(openAiBaseUrlForRequest(used.aiOpenAiBaseUrl)).toBe(DEFAULT_OPENAI_BASE_URL)
  })
})

describe('describeEffectiveAiEndpoint', () => {
  const HTTP = 'http://llm.lan:8080'

  it('an http endpoint counts only under the provider that uses it', () => {
    expect(describeEffectiveAiEndpoint({ aiOpenAiBaseUrl: HTTP, aiProvider: 'openai-api' }))
      .toEqual({ active: true, cleartext: true })
    for (const provider of ['gemini-api', 'anthropic-api', 'subscription', undefined]) {
      expect(describeEffectiveAiEndpoint({ aiOpenAiBaseUrl: HTTP, aiProvider: provider }), provider)
        .toEqual({ active: false, cleartext: false })
    }
  })

  it('an https endpoint is never cleartext, active or not', () => {
    expect(describeEffectiveAiEndpoint({ aiOpenAiBaseUrl: 'https://llm.example.tld', aiProvider: 'openai-api' }))
      .toEqual({ active: true, cleartext: false })
    expect(describeEffectiveAiEndpoint({ aiProvider: 'openai-api' }))
      .toEqual({ active: true, cleartext: false })
  })

  it('an unusable stored endpoint makes no cleartext claim — no request is built from it', () => {
    expect(describeEffectiveAiEndpoint({ aiOpenAiBaseUrl: 'not a url', aiProvider: 'openai-api' }))
      .toEqual({ active: true, cleartext: false })
  })

  it('isOpenAiCompatibleProvider names the one provider with a configurable endpoint', () => {
    expect(isOpenAiCompatibleProvider('openai-api')).toBe(true)
    for (const p of ['gemini-api', 'anthropic-api', 'subscription', '', undefined]) {
      expect(isOpenAiCompatibleProvider(p), String(p)).toBe(false)
    }
  })
})

describe('withEffectiveProvider', () => {
  const base = { aiOpenAiBaseUrl: 'http://llm.lan:8080', aiProvider: 'gemini-api' }

  it('uses the provider the request will run under, not the stored one', () => {
    expect(withEffectiveProvider(base, 'openai-api').aiProvider).toBe('openai-api')
    expect(describeEffectiveAiEndpoint(withEffectiveProvider(base, 'openai-api')).cleartext).toBe(true)
  })

  it('keeps the stored provider when the caller did not name one', () => {
    expect(withEffectiveProvider(base, undefined)).toBe(base)
  })
})

describe('isCleartextDestination', () => {
  it('is true only for an http:// url', () => {
    expect(isCleartextDestination(resolveAiDestination('aiOpenAiBaseUrl', 'http://llm.local:8080'))).toBe(true)
    expect(isCleartextDestination(resolveAiDestination('aiOpenAiBaseUrl', 'https://llm.example.tld'))).toBe(false)
    expect(isCleartextDestination(resolveAiDestination('aiOpenAiBaseUrl', undefined))).toBe(false)
    expect(isCleartextDestination(resolveAiDestination('aiProxyUrl', undefined))).toBe(false)
    expect(isCleartextDestination(resolveAiDestination('aiProxyUrl', 'socks5://p:1080'))).toBe(false)
  })
})

describe('applyAiDestinationDecision', () => {
  const current = { aiOpenAiBaseUrl: 'https://llm.example.tld', aiProxyUrl: undefined }

  it('keeps the requested addresses when the change was confirmed', () => {
    const merged = { theme: 'dark', aiOpenAiBaseUrl: 'https://new.tld', aiProxyUrl: 'http://p:1' }
    expect(applyAiDestinationDecision(merged, current, true)).toEqual(merged)
  })

  it('puts BOTH addresses back and keeps every other edit when it was not', () => {
    const merged = { theme: 'dark', aiOpenAiBaseUrl: 'https://collector.evil.tld', aiProxyUrl: 'http://mitm.evil.tld:8080' }
    expect(applyAiDestinationDecision(merged, current, false)).toEqual({
      theme: 'dark',
      aiOpenAiBaseUrl: current.aiOpenAiBaseUrl,
      aiProxyUrl: current.aiProxyUrl,
    })
  })
})
