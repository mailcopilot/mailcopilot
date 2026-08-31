/**
 * Where an AI request — and with it the user's API key — is actually sent.
 * BACKLOG §2.119.
 *
 * Two settings decide that address, and both are renderer-writable:
 *
 *  - `aiOpenAiBaseUrl` becomes `${base}/v1/chat/completions`, `${base}/v1/models`
 *    and the SDK's `baseURL`, each called with `Authorization: Bearer <key>`.
 *    Whoever runs that host is the TLS peer, so they hold the key and every
 *    prompt outright. Nothing restricts the scheme to https, so an `http://`
 *    endpoint additionally puts both on the wire in cleartext.
 *  - `aiProxyUrl` is handed to undici's `ProxyAgent` and exported as
 *    `HTTPS_PROXY`/`HTTP_PROXY` into the Claude CLI child process. An ordinary
 *    forward proxy is reached by `CONNECT` and TLS then runs end to end to the
 *    origin, so what it gets is WHERE every AI request goes plus its size and
 *    timing — not the `Authorization` header and not the body. It reads those
 *    only when the traffic is cleartext (an `http://` endpoint) or when it
 *    intercepts TLS with a certificate this machine already trusts, which is a
 *    separate condition the user has separately accepted. Redirecting the
 *    traffic is worth a human either way; overstating what a proxy sees is not
 *    (see the prompt wording in ./aiDestinationGuard.ts).
 *
 * They stay writable — pointing the client at a self-hosted or third-party
 * OpenAI-compatible endpoint, or through a corporate proxy, is a wanted
 * capability. What must not happen is that the address a secret travels to
 * changes with no human in the loop, so ./aiDestinationGuard.ts puts a native
 * confirmation in front of a CHANGE.
 *
 * This module is the pure half: it answers "is this the same destination as
 * before?" and nothing else. No electron import, no I/O, no state — so every
 * normalisation rule below is unit-testable on its own, and the guard is left
 * with only the parts that genuinely need the main process (a dialog, a
 * session-scoped approval set, a mutex).
 */
import { z } from 'zod'

/** The two settings fields that decide where the key is sent. */
export type AiDestinationField = 'aiOpenAiBaseUrl' | 'aiProxyUrl'

/** Iteration order for the fields — also the order they appear in the prompt. */
export const AI_DESTINATION_FIELDS: readonly AiDestinationField[] = [
  'aiOpenAiBaseUrl',
  'aiProxyUrl',
]

/** The address used when `aiOpenAiBaseUrl` is unset — the vendor's own API. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'

/** Upper bound on an address this module will canonicalise. Anything longer is
 *  treated as unusable rather than truncated — see
 *  {@link canonicalizeAiDestinationUrl}. */
export const MAX_AI_DESTINATION_LENGTH = 512

/** Thrown for a stored endpoint that cannot be turned into an unambiguous
 *  request base. Carries NO part of the offending value: the message reaches a
 *  user-visible error string on some paths (CLAUDE.md §8). */
export class UnusableAiEndpointError extends Error {
  constructor() {
    super('AI endpoint address is not a usable API base URL')
    this.name = 'UnusableAiEndpointError'
  }
}

/** One endpoint address, parsed once. */
export interface AiEndpointBase {
  /** Exactly the string ai.ts concatenates `/v1/...` onto. */
  requestBase: string
  /** The approval identity — deliberately the SAME string as `requestBase`. */
  identity: string
  /** What the human is shown: explicit port, never any credentials. */
  display: string
}

/**
 * Parse an OpenAI-compatible base address into the three forms that must agree.
 *
 * WHY ONE PARSE PRODUCES ALL THREE. The address the guard approved and the URL
 * that goes on the wire used to be derived from two different representations
 * of the same string: the identity came from `new URL(...)` (which drops the
 * fragment), the request came from string concatenation onto the raw value. So
 * `https://gw/tenant#x` and `https://gw/tenant` were ONE approved identity,
 * while the requests they produce are `https://gw/tenant` (everything after
 * `#` never leaves the machine) and `https://gw/tenant/v1/models` — different
 * resources on a path-routed gateway, no second confirmation. That is the same
 * defect as the `??` merge: two rules for one value. `identity` is now defined
 * to BE `requestBase`, so the property "what was judged is what is requested"
 * holds by construction and cannot be re-broken by a normalisation tweak.
 *
 * A QUERY OR A FRAGMENT IS REFUSED, not stripped. Both are meaningless in an
 * API base that we append a path to: a fragment never reaches a server at all,
 * and `${base}?a=b` + `/v1/models` yields a URL whose path is not the approved
 * one. Dropping either would be exactly the silent reinterpretation this parse
 * exists to end, so an address carrying one is not usable — the guard refuses
 * such a value outright and the request layer throws rather than guessing.
 *
 * EMBEDDED CREDENTIALS ARE KEPT in `requestBase`/`identity` and omitted from
 * `display`: they must reach the server for a gateway that needs them (that is
 * today's behaviour and dropping them would be another silent reinterpretation),
 * they must be part of the comparison because they are part of the URL that is
 * sent, and they must never be rendered into a dialog. `display` is the only
 * one of the three a human or a log ever sees.
 *
 * A trailing `/v1` is stripped because ai.ts appends its own, so `https://h/v1`
 * and `https://h` produce byte-identical request URLs.
 */
export function parseAiEndpointBase(raw: string | undefined): AiEndpointBase | null {
  const trimmed = raw?.trim() || DEFAULT_OPENAI_BASE_URL
  if (trimmed.length > MAX_AI_DESTINATION_LENGTH) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  // `search`/`hash` are empty strings when absent, and also when the raw value
  // ends in a bare `?`/`#` — which carries no information and is accepted.
  if (url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  const credentials = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : ''
  // `url.host` is hostname plus a non-default port only — the same rule the
  // identity used before, now shared with the request.
  const requestBase = `${url.protocol}//${credentials}${url.host}${path}`
  const explicitPort = url.port || (url.protocol === 'https:' ? '443' : '80')
  return {
    requestBase,
    identity: requestBase,
    display: `${url.protocol}//${url.hostname}:${explicitPort}${path}`,
  }
}

/**
 * The base URL as the request layer will actually use it.
 *
 * SINGLE SOURCE OF TRUTH, imported by `normalizeOpenAiBaseUrl` in
 * electron/services/ai.ts, and the same parse the guard's identity comes from.
 *
 * THROWS for an address that cannot be turned into an unambiguous request base
 * instead of returning something that "mostly works". The values that reach
 * here unparseable are stored ones — the guard refuses new ones — and for those
 * the old fall-through produced a request to a path nobody approved. Failing
 * the AI call is the conservative half of that choice: no key leaves the
 * process, and the user gets an error naming the setting.
 */
export function openAiBaseUrlForRequest(raw: string | undefined): string {
  const parsed = parseAiEndpointBase(raw)
  if (!parsed) throw new UnusableAiEndpointError()
  return parsed.requestBase
}

/**
 * A resolved destination.
 *
 *  - `direct` — no proxy at all (only `aiProxyUrl` can be in this state; an
 *    unset base URL still resolves to the vendor default);
 *  - `invalid` — a value that is not a usable http(s) address. It is never
 *    accepted as a NEW destination: the confirmation prompt has to name a
 *    concrete host, and a value the request layer cannot use either fails
 *    later or, worse, resolves somewhere unintended;
 *  - `url` — `identity` is the comparison form, `display` is what the human is
 *    asked about.
 */
export type AiDestination =
  | { kind: 'direct' }
  | { kind: 'invalid' }
  | { kind: 'url'; identity: string; display: string }

/**
 * Canonical form of an http(s) address, or `null` when it is not one.
 *
 * THE PROXY FIELD ONLY. The endpoint has its own, stricter parse
 * ({@link parseAiEndpointBase}) because we CONCATENATE a path onto it, so the
 * approved form has to be the literal prefix of the requested URL. A proxy
 * address is handed to `ProxyAgent`/`HTTPS_PROXY` whole, exactly as stored, so
 * there is no second representation to disagree with: two raw strings that
 * normalise together here dial the same proxy, which is what the comparison is
 * for. That is also why a query survives here and is refused there.
 *
 * What is deliberately NORMALISED AWAY — differences that do not change which
 * host receives the key, and where asking again would only teach the user to
 * click through:
 *   - case of the scheme and host (`HTTPS://API.Example.COM` is one address);
 *   - a port that equals the scheme's default (`https://h:443` ≡ `https://h`);
 *   - trailing slashes on the path, and a fragment (never sent to a server).
 *
 * What is deliberately KEPT, because it selects a different recipient or a
 * different resource on it: the scheme (an https→http downgrade is a change),
 * the host, a non-default port, the path prefix and the query.
 *
 * A host written in Unicode is canonicalised to its punycode serialisation by
 * `URL` itself, which is what we want in the prompt too: the ASCII form is
 * where the request will actually go, and showing the Unicode one would hand
 * the user a homograph (same reasoning as `resolveLinkTarget` in
 * ./contextMenu.ts).
 *
 * USERINFO IS DROPPED from both forms. A proxy address may legitimately carry
 * `user:password@`, and (a) a change of credentials on the same host does not
 * redirect the key anywhere new, so it is not the event this guard exists for,
 * and (b) `display` is put in front of the user and into no log, but keeping a
 * password out of a string that is built for display is the cheaper invariant
 * to hold.
 */
export function canonicalizeAiDestinationUrl(
  raw: string,
): { identity: string; display: string } | null {
  // Bound the input before anything is built from it. `display` ends up in a
  // native dialog, and a kilometre-long path would push the warning text out
  // of the box — a real address never comes near this bound.
  if (raw.length > MAX_AI_DESTINATION_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  const path = url.pathname.replace(/\/+$/, '')
  const query = url.search
  // Empty for a default port — `URL` drops it during parsing.
  const port = url.port
  const authority = `${url.hostname}${port ? `:${port}` : ''}`
  // The prompt names the port explicitly even when it is the default one: the
  // user is agreeing to a concrete endpoint, and "443" being implied is not
  // something a reader should have to know.
  const explicitPort = port || (url.protocol === 'https:' ? '443' : '80')
  return {
    identity: `${url.protocol}//${authority}${path}${query}`,
    display: `${url.protocol}//${url.hostname}:${explicitPort}${path}${query}`,
  }
}

/** Resolve the stored/requested value of one field into a destination. */
export function resolveAiDestination(
  field: AiDestinationField,
  raw: string | undefined,
): AiDestination {
  if (field === 'aiOpenAiBaseUrl') {
    // An unset base URL is not "no destination": requests go to the vendor
    // default, so clearing a self-hosted endpoint sends the key to OpenAI and
    // is as much a change of recipient as any other.
    //
    // THE SAME PARSE the request is built from — not a second canonicalisation
    // of it. See {@link parseAiEndpointBase}.
    const parsed = parseAiEndpointBase(raw)
    return parsed
      ? { kind: 'url', identity: parsed.identity, display: parsed.display }
      : { kind: 'invalid' }
  }
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'direct' }
  const canonical = canonicalizeAiDestinationUrl(trimmed)
  return canonical ? { kind: 'url', ...canonical } : { kind: 'invalid' }
}

/**
 * Whether the request layer will reach this destination over cleartext http.
 *
 * Only meaningful for `aiOpenAiBaseUrl`: an `http://` PROXY address is the
 * ordinary way of writing a forward proxy and says nothing about the traffic
 * it tunnels, so the prompt must not cry cleartext for it.
 */
export function isCleartextDestination(destination: AiDestination): boolean {
  return destination.kind === 'url' && destination.identity.startsWith('http://')
}

/**
 * The not-yet-saved destination overrides `ai:checkAuth` accepts.
 *
 * Lives here, next to the merge rule, because a test that wants to prove the
 * handler's real behaviour must be able to produce the handler's real parsed
 * payload. The shape matters to the merge: zod keeps a key that was PRESENT
 * with `undefined` as an own property of the result, which is exactly the case
 * the rule below turns on.
 */
export const aiDestinationOverridesSchema = z.object({
  aiProxyUrl: z.string().trim().optional(),
  aiOpenAiBaseUrl: z.string().trim().optional(),
}).optional()

/**
 * THE merge rule for the two destination fields — one implementation, used by
 * both write paths (`settings:save` and the `ai:checkAuth` overrides) for BOTH
 * the values handed to the guard and the values the request is then built from.
 *
 * The rule is the object spread `{ ...current, ...payload }`: a key that is
 * absent from the payload keeps the persisted value, and a key that is PRESENT
 * with `undefined` clears it — the settings window sends exactly that for an
 * emptied input, and so does a `checkAuth` payload whose optional field was
 * parsed from an explicit `undefined`.
 *
 * The two cases are NOT interchangeable, and `payload[field] ?? current[field]`
 * collapses them: it loses the clear when judging while the spread still
 * performs it when acting, so the key starts going to the vendor default with
 * no prompt. That was a live bypass on `ai:checkAuth` (fix wave after the
 * §2.119 review). Hence one function rather than one rule written twice —
 * "judged" and "used" have to be the same code, not the same intention.
 *
 * Accepts `unknown` because that is what the IPC handler holds at this point:
 * a non-object payload asks for nothing and is answered with the current
 * values (the handler's own schema parse rejects it a few lines later).
 */
export function resolveRequestedAiDestination(
  payload: unknown,
  current: AiDestinationSettings,
): AiDestinationSettings {
  const source = typeof payload === 'object' && payload !== null
    ? payload as Record<string, unknown>
    : {}
  const pick = (field: keyof AiDestinationSettings): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) return current[field]
    const value = source[field]
    return typeof value === 'string' ? value : undefined
  }
  return {
    aiOpenAiBaseUrl: pick('aiOpenAiBaseUrl'),
    aiProxyUrl: pick('aiProxyUrl'),
    // Same rule, for a field that is described rather than gated: a save can
    // switch the provider in the SAME payload that moves an address, and the
    // prompt has to describe the provider that will be in force afterwards, not
    // the one on disk. `applyAiDestinationOverrides` deliberately does not
    // write it back — only the two gated fields are (re)written from here.
    aiProvider: pick('aiProvider'),
  }
}

/**
 * Apply a requested destination to the settings an AI request will be built
 * from, through {@link resolveRequestedAiDestination} — the same call that
 * produced the values the guard judged.
 *
 * Every other field is left exactly as the caller had it; only the two address
 * fields are (re)written, and they are written by the rule that judged them.
 */
export function applyAiDestinationOverrides<T extends AiDestinationSettings>(
  current: T,
  requested: unknown,
): T {
  const resolved = resolveRequestedAiDestination(requested, current)
  return {
    ...current,
    aiOpenAiBaseUrl: resolved.aiOpenAiBaseUrl,
    aiProxyUrl: resolved.aiProxyUrl,
  }
}

/**
 * Apply the outcome of the confirmation to a settings object about to be
 * written: when the change was not confirmed, the two destination fields go
 * back to what is stored, and everything else in the save is kept.
 *
 * A pure function rather than three lines inside the IPC handler, because
 * "the setting only changes on acceptance" is the whole point of the feature
 * and deserves a test that can see it directly.
 */
export function applyAiDestinationDecision<T extends AiDestinationSettings>(
  merged: T,
  current: AiDestinationSettings,
  approved: boolean,
): T {
  if (approved) return merged
  return {
    ...merged,
    aiOpenAiBaseUrl: current.aiOpenAiBaseUrl,
    aiProxyUrl: current.aiProxyUrl,
  }
}

/** One field whose destination differs between two settings states. */
export interface AiDestinationChange {
  field: AiDestinationField
  from: AiDestination
  to: AiDestination
}

/**
 * The subset of settings this module reads.
 *
 * `aiProvider` is NOT a gated field — moving it changes which vendor API and
 * which key are used, not the address of a field this guard owns. It is here
 * because the WARNING TEXT describes a composite state: the endpoint setting
 * only takes effect under the OpenAI-compatible provider, so whether an
 * `http://` endpoint means "your proxy can read the key" depends on the
 * provider that will be in force after the save. See
 * {@link isOpenAiCompatibleProvider}.
 */
export interface AiDestinationSettings {
  aiOpenAiBaseUrl?: string
  aiProxyUrl?: string
  aiProvider?: string
}

/** The one provider whose endpoint address the user configures. Every other
 *  provider is pinned to its vendor's https API (see `isLocalInferenceEndpoint`
 *  in ./ai.ts, which states the same invariant for metering), so under those
 *  `aiOpenAiBaseUrl` is stored but inert. */
export function isOpenAiCompatibleProvider(provider: string | undefined): boolean {
  return provider === 'openai-api'
}

/**
 * The endpoint AI requests will actually reach in the state `next` describes,
 * as a pair of facts the prompt wording is derived from.
 *
 * `active` — the configurable endpoint is the one in use. When it is false the
 * address is stored but inert, and a prompt that says "every AI request to this
 * address carries your API key" is describing something that is not happening.
 *
 * `cleartext` — that endpoint is reached over plain http, which is what decides
 * whether an ordinary forward proxy reads the key and the messages or only sees
 * where the traffic goes. It can only be true when `active` is: a vendor API is
 * https, so an unused `http://` value in settings must not colour the proxy
 * warning (this was a live inaccuracy — provider Gemini, an old http endpoint in
 * settings, and the proxy prompt claimed the proxy could read everything).
 */
export function describeEffectiveAiEndpoint(
  next: AiDestinationSettings,
): { active: boolean; cleartext: boolean } {
  const active = isOpenAiCompatibleProvider(next.aiProvider)
  const configured = resolveAiDestination('aiOpenAiBaseUrl', next.aiOpenAiBaseUrl)
  return { active, cleartext: isCleartextDestination(configured) && active }
}

/** `settings` with the provider an in-flight request will actually run under.
 *  `ai:checkAuth` takes the provider as a SEPARATE argument and uses it for the
 *  request, so the guard has to be told about it or the prompt describes the
 *  stored provider instead of the one being tested. */
export function withEffectiveProvider(
  settings: AiDestinationSettings,
  providerOverride: string | undefined,
): AiDestinationSettings {
  return providerOverride ? { ...settings, aiProvider: providerOverride } : settings
}

/** Registry key for an approved destination — field-scoped, so approving an
 *  endpoint never silently approves the same host as a proxy. */
export function aiDestinationApprovalKey(change: AiDestinationChange): string {
  const target = change.to.kind === 'url' ? change.to.identity : `#${change.to.kind}`
  return `${change.field} ${target}`
}

/**
 * Which of the two fields would send the key somewhere it is not being sent
 * today. An empty result means nothing needs a human.
 *
 * Three things are deliberately NOT a change:
 *
 *  1. the identical value saved again — the common case, since every
 *     `settings:save` in this app round-trips the whole settings object;
 *  2. a value that only differs from the stored one in a way
 *     {@link canonicalizeAiDestinationUrl} normalises away;
 *  3. REMOVING the proxy (`to.kind === 'direct'`). Every other transition adds
 *     or replaces a party that terminates the TLS connection and reads the
 *     `Authorization` header; removing one strictly reduces that set, and the
 *     endpoint the traffic then reaches directly was already approved. Asking
 *     for a confirmation to stop trusting something would be the same mistake
 *     as making withdrawal harder than consent (CLAUDE.md §2.82).
 *
 * Note that this compares EFFECTIVE destinations, not raw strings, in both
 * directions: an unparseable stored value that is left alone is not a change
 * (we gate changes, we do not retro-validate what is already on disk), while
 * an unparseable NEW value is reported as a change whose `to` is `invalid` so
 * the caller can refuse it without opening a dialog it cannot fill in.
 */
export function planAiDestinationChanges(
  current: AiDestinationSettings,
  next: AiDestinationSettings,
): AiDestinationChange[] {
  const changes: AiDestinationChange[] = []
  for (const field of AI_DESTINATION_FIELDS) {
    const rawFrom = current[field]
    const rawTo = next[field]
    if ((rawFrom ?? '').trim() === (rawTo ?? '').trim()) continue
    const from = resolveAiDestination(field, rawFrom)
    const to = resolveAiDestination(field, rawTo)
    if (to.kind === 'direct') continue
    if (from.kind === 'url' && to.kind === 'url' && from.identity === to.identity) continue
    changes.push({ field, from, to })
  }
  return changes
}
