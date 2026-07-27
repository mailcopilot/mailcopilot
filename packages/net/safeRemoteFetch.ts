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

type ResolvedAddress = {
  address: string
  family: 4 | 6
}

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

    const isUnspecified = bytes.every(b => b === 0)
    const isLoopback = bytes.slice(0, 15).every(b => b === 0) && bytes[15] === 1
    const isUniqueLocal = (bytes[0] & 0xfe) === 0xfc
    const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80
    const isMulticast = bytes[0] === 0xff
    const isIpv4Mapped = bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff

    if (isIpv4Mapped) {
      const mapped = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
      return isBlockedRemoteAddress(mapped)
    }

    return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast
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
      lookup: (_hostname, _opts, cb) => cb(null, resolved.address, resolved.family),
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

async function requestSafeRemote(
  url: string,
  options: SafeRemoteRequestOptions,
): Promise<SafeRemoteResponse> {
  let current = new URL(url)
  let requestOptions = { ...options }
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('blocked protocol')
    }

    const resolved = await resolveSafeAddress(current.hostname)
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
        stream.destroy(new Error('response too large'))
        return
      }
      chunks.push(buffer)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks, total)))
    stream.on('aborted', () => reject(new Error('response aborted')))
    stream.on('error', reject)
  })
}

export async function requestSafeRemoteStatus(
  url: string,
  options: SafeRemoteRequestOptions = {},
): Promise<SafeRemoteStatusResponse> {
  const response = await requestSafeRemote(url, options)
  response.bodyStream.destroy()
  return {
    url: response.url,
    status: response.status,
    headers: response.headers,
  }
}

export async function requestSafeRemoteBytes(
  url: string,
  maxBytes: number,
  options: SafeRemoteRequestOptions = {},
): Promise<SafeRemoteBytesResponse> {
  const response = await requestSafeRemote(url, options)

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
