import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 5

export type SafeRemoteRequestOptions = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  maxRedirects?: number
}

export type SafeRemoteStatusResponse = {
  url: string
  status: number
  headers: http.IncomingHttpHeaders
}

export type SafeRemoteBytesResponse = SafeRemoteStatusResponse & {
  body: Buffer
}

export type ResolvedAddress = {
  address: string
  family: 4 | 6
}

/**
 * Hostname -> vetted address resolver. Exists so the redirect loop can be
 * exercised in tests; see the seam note on `__testOnly`. Not a parameter of
 * any public function.
 */
export type SafeAddressResolver = (hostname: string) => Promise<ResolvedAddress>

type SafeRemoteResponse = SafeRemoteStatusResponse & {
  bodyStream: http.IncomingMessage
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim()
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1)
  return normalized
}

function parseIpv4Bytes(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map(part => Number(part))
  if (bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return bytes
}

function expandIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase()
  const zoneIndex = normalized.indexOf('%')
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex)

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':')
    if (lastColon < 0) return null
    const ipv4Bytes = parseIpv4Bytes(normalized.slice(lastColon + 1))
    if (!ipv4Bytes) return null
    const hi = ((ipv4Bytes[0] << 8) | ipv4Bytes[1]).toString(16)
    const lo = ((ipv4Bytes[2] << 8) | ipv4Bytes[3]).toString(16)
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`
  }

  const parts = normalized.split('::')
  if (parts.length > 2) return null

  const head = parts[0] ? parts[0].split(':').filter(Boolean) : []
  const tail = parts[1] ? parts[1].split(':').filter(Boolean) : []
  const missing = parts.length === 2 ? 8 - head.length - tail.length : 0

  if (parts.length === 1 && head.length !== 8) return null
  if (parts.length === 2 && missing < 1) return null

  const groups = parts.length === 1
    ? head
    : [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  if (groups.length !== 8) return null

  const bytes: number[] = []
  for (const group of groups) {
    const value = Number.parseInt(group, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes
}

function embeddedIpv4(bytes: number[], offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
}

export function isBlockedRemoteHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname).toLowerCase()
  return (
    h === 'localhost'
    || h.endsWith('.localhost')
    || h.endsWith('.local')
    || h.endsWith('.internal')
    || h.endsWith('.home.arpa')
  )
}

export function isBlockedRemoteAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) {
    const bytes = parseIpv4Bytes(address)
    if (!bytes) return true
    const [a, b] = bytes
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    )
  }

  if (family === 6) {
    const bytes = expandIpv6(address)
    if (!bytes) return true

    // Prefixes that embed an IPv4 address are decided by the IPv4 block list,
    // not by the IPv6 one: `::ffff:8.8.8.8`, `64:ff9b::8.8.8.8` and
    // `2002:808:808::` all name a public IPv4 host and must stay reachable,
    // while the same prefixes over 127.0.0.1 / RFC 1918 must not. Order is
    // load-bearing: IPv4-mapped and NAT64 both live inside `::/8`, which is
    // blocked wholesale below — checking that first would block the public
    // forms too.
    const isIpv4Mapped = bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    if (isIpv4Mapped) return isBlockedRemoteAddress(embeddedIpv4(bytes, 12))

    // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052 §2.1).
    const isNat64 = bytes[0] === 0x00 && bytes[1] === 0x64
      && bytes[2] === 0xff && bytes[3] === 0x9b
      && bytes.slice(4, 12).every(b => b === 0)
    if (isNat64) return isBlockedRemoteAddress(embeddedIpv4(bytes, 12))

    // 6to4 2002::/16 (RFC 3056 §2) — bytes 2..5 carry the IPv4 endpoint.
    const is6to4 = bytes[0] === 0x20 && bytes[1] === 0x02
    if (is6to4) return isBlockedRemoteAddress(embeddedIpv4(bytes, 2))

    // The whole of `::/8` is IANA-reserved, so no legitimate global unicast
    // host lives there. Blocking the range as a whole (rather than `::` and
    // `::1` one by one) also covers the deprecated IPv4-compatible form
    // (`::127.0.0.1`) and the IPv4-translated form (`::ffff:0:7f00:1`) — both
    // of which reached loopback through a block list that only knew about
    // IPv4-mapped addresses.
    if (bytes[0] === 0) return true

    const isUniqueLocal = (bytes[0] & 0xfe) === 0xfc
    const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80
    // Site-local fec0::/10 (deprecated by RFC 3879, still routed on kit that
    // predates the deprecation). It is a sibling of link-local inside `fe00::/8`
    // and needs its own test: `isLinkLocal` matches only the `10` bit pattern,
    // so `fec0::1` walked straight through.
    const isSiteLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0
    const isMulticast = bytes[0] === 0xff

    return isUniqueLocal || isLinkLocal || isSiteLocal || isMulticast
  }

  return true
}

async function resolveSafeAddress(hostname: string): Promise<ResolvedAddress> {
  const normalizedHostname = normalizeHostname(hostname)
  const literalFamily = net.isIP(normalizedHostname)
  if (literalFamily) {
    if (isBlockedRemoteAddress(normalizedHostname)) throw new Error('blocked host')
    return { address: normalizedHostname, family: literalFamily as 4 | 6 }
  }

  if (isBlockedRemoteHostname(normalizedHostname)) throw new Error('blocked host')

  const resolved = await dns.promises.lookup(normalizedHostname, { all: true, verbatim: true })
  if (resolved.length === 0) throw new Error('DNS lookup returned no results')

  for (const entry of resolved) {
    if (isBlockedRemoteAddress(entry.address)) throw new Error('blocked host')
  }

  const first = resolved[0]
  return { address: first.address, family: first.family as 4 | 6 }
}

/**
 * Builds the `lookup` callback that pins a connection to one already-vetted IP
 * (DNS-rebinding guard: we never let the socket layer re-resolve the hostname).
 *
 * Precondition, and it is a rule rather than a description: `resolved` MUST be
 * the return value of `resolveSafeAddress`. Do not build it from the URL, from
 * a header, from a redirect target or from a raw DNS answer — this function is
 * exported, and `ResolvedAddress` is structurally just a string plus a number,
 * so it cannot tell a vetted address from an arbitrary one. Every guarantee of
 * this module (block list, no rebinding) rides on that precondition.
 *
 * The callback MUST answer in two shapes. Since Node 20 sockets enable
 * `autoSelectFamily` (Happy Eyeballs, RFC 8305) by default, `net` calls
 * `lookup` with `{ all: true }` and then iterates the result as an array of
 * `{ address, family }` records. Handing it the legacy `(err, address, family)`
 * triple in that mode makes Node read `addresses[0].address` off a string,
 * get `undefined`, and throw `ERR_INVALID_IP_ADDRESS` before any socket opens.
 * The plain triple is still required for callers that pass no `all` option.
 * Do not "simplify" this back to a single shape: the `{ all: true }` branch is
 * there to satisfy the callback contract of Node >= 20, not to preserve Happy
 * Eyeballs. Happy Eyeballs cannot run here by construction — the pin carries
 * exactly one address, so there is no family race left to win. That is the
 * accepted price of the rebinding guard: one vetted address, no fallback.
 */
export function createPinnedLookup(resolved: ResolvedAddress): net.LookupFunction {
  return (_hostname, opts, cb) => {
    if (opts?.all) cb(null, [{ address: resolved.address, family: resolved.family }])
    else cb(null, resolved.address, resolved.family)
  }
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

function requestOnce(
  url: URL,
  resolved: ResolvedAddress,
  options: SafeRemoteRequestOptions,
): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  return new Promise((resolve, reject) => {
    const hostname = normalizeHostname(url.hostname)
    const req = client.request({
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
      signal,
      lookup: createPinnedLookup(resolved),
    }, resolve)

    req.on('error', reject)
    req.end(options.body)
  })
}

function normalizeRedirectRequest(
  status: number,
  options: SafeRemoteRequestOptions,
): SafeRemoteRequestOptions {
  const method = options.method ?? 'GET'
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    return {
      ...options,
      method: 'GET',
      body: undefined,
      headers: Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(([key]) => {
          const normalizedKey = key.toLowerCase()
          return normalizedKey !== 'content-type' && normalizedKey !== 'content-length'
        }),
      ),
    }
  }
  return options
}

/**
 * Walks the redirect chain, re-vetting the host on every hop.
 *
 * Scheme rule: a chain that has been on `https:` at least once never steps
 * back to `http:` ('blocked downgrade'). The flag is "have we ever seen
 * https", not "what was the initial scheme" — `http -> https -> http` also
 * puts back on the wire what already travelled inside TLS, and a rule phrased
 * against the initial scheme would wave that chain through. The opposite
 * direction (`http -> https`) is an upgrade and stays allowed, so a chain that
 * is `http:` end to end keeps working: `net:fetchExternalImage` legitimately
 * accepts `http://` image URLs.
 *
 * `resolveAddress` is required rather than defaulted: this is the internal
 * core, and the only two callers are the thin wrappers below. See `__testOnly`
 * for why the seam exists at all and why it is not on the public functions.
 */
async function requestSafeRemote(
  url: string,
  options: SafeRemoteRequestOptions,
  resolveAddress: SafeAddressResolver,
): Promise<SafeRemoteResponse> {
  let current = new URL(url)
  let requestOptions = { ...options }
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  let sawHttps = false

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('blocked protocol')
    }
    if (current.protocol === 'https:') sawHttps = true
    else if (sawHttps) throw new Error('blocked downgrade')

    const resolved = await resolveAddress(current.hostname)
    const response = await requestOnce(current, resolved, requestOptions)
    const status = response.statusCode ?? 0

    if (status >= 300 && status < 400) {
      const location = readHeaderValue(response.headers.location)
      response.destroy()
      if (!location) throw new Error('redirect without location')
      if (redirects === maxRedirects) throw new Error('too many redirects')
      current = new URL(location, current)
      requestOptions = normalizeRedirectRequest(status, requestOptions)
      continue
    }

    return {
      url: current.href,
      status,
      headers: response.headers,
      bodyStream: response,
    }
  }

  throw new Error('too many redirects')
}

function readBodyWithLimit(stream: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        const tooLarge = new Error('response too large')
        // Reject before destroying: destroying makes the stream emit
        // 'aborted' as well, and that listener would otherwise win the race
        // and report a transport failure for what is our own size cap.
        reject(tooLarge)
        stream.destroy(tooLarge)
        return
      }
      chunks.push(buffer)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks, total)))
    stream.on('aborted', () => reject(new Error('response aborted')))
    stream.on('error', reject)
  })
}

/**
 * Internal core of `requestSafeRemoteStatus`, with the resolver seam exposed.
 * Not exported directly — reachable from the suite only through `__testOnly`.
 */
async function statusWithResolver(
  url: string,
  options: SafeRemoteRequestOptions,
  resolveAddress: SafeAddressResolver,
): Promise<SafeRemoteStatusResponse> {
  const response = await requestSafeRemote(url, options, resolveAddress)
  response.bodyStream.destroy()
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
  }
}

/** Internal core of `requestSafeRemoteBytes` — see `statusWithResolver`. */
async function bytesWithResolver(
  url: string,
  maxBytes: number,
  options: SafeRemoteRequestOptions,
  resolveAddress: SafeAddressResolver,
): Promise<SafeRemoteBytesResponse> {
  const response = await requestSafeRemote(url, options, resolveAddress)

  const contentLength = Number(readHeaderValue(response.headers['content-length']) || NaN)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.bodyStream.destroy()
    throw new Error('response too large')
  }

  const body = await readBodyWithLimit(response.bodyStream, maxBytes)
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
    body,
  }
}

/**
 * The SSRF-safe entry point for any URL that came out of an email (one-click
 * unsubscribe). Hostname resolution and the block list are NOT parameters: the
 * signature ends here, so no call site can pass one more argument and end up
 * with the block list switched off.
 */
export function requestSafeRemoteStatus(
  url: string,
  options: SafeRemoteRequestOptions = {},
): Promise<SafeRemoteStatusResponse> {
  return statusWithResolver(url, options, resolveSafeAddress)
}

/**
 * The SSRF-safe entry point for email-derived URLs whose body we read
 * (`net:fetchExternalImage`). Same rule as `requestSafeRemoteStatus`: the
 * resolver is not part of the signature.
 */
export function requestSafeRemoteBytes(
  url: string,
  maxBytes: number,
  options: SafeRemoteRequestOptions = {},
): Promise<SafeRemoteBytesResponse> {
  return bytesWithResolver(url, maxBytes, options, resolveSafeAddress)
}

/**
 * Only the test suite may touch this; production code calls the public
 * functions above.
 *
 * The seam hands the redirect loop a stub resolver, because the loop is
 * otherwise unreachable from a test: every address a local server can bind is
 * one the block list rightly refuses, and loosening the block list to make a
 * test possible is forbidden. It lives here, behind a name no production call
 * site would write by accident, rather than as a trailing optional parameter
 * of the public functions — as a parameter, one extra argument at a call site
 * silently disables the block list, and the public functions are exactly the
 * ones CLAUDE.md tells every caller to use for untrusted URLs.
 *
 * The block list itself is not seamed: the guard tests drive the PUBLIC entry
 * points with loopback/private literals and expect 'blocked host'.
 */
export const __testOnly = {
  requestSafeRemoteStatus: statusWithResolver,
  requestSafeRemoteBytes: bytesWithResolver,
}
