/**
 * Category of a failed AI request, for the one sentence the user sees.
 *
 * Read from STRUCTURE only: the HTTP status a typed provider error carries, a syscall code, or the `type` of an
 * error payload sent inside an open stream. Message text is never consulted, so a provider's own wording (or a
 * user's prompt echoed back by it) cannot pick the category. Anything not recognised is `undefined`: main then
 * says nothing about the cause rather than guess one.
 */
import { RetryError } from 'ai'

/** Closed category of a failed request. */
export type AiFailureKind = 'network' | 'timeout' | 'access' | 'limit' | 'model' | 'endpoint' | 'provider'

const TIMEOUT_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'])
const MODEL_TYPES: ReadonlySet<string> = new Set(['not_found_error', 'model_not_found'])
const LIMIT_TYPES: ReadonlySet<string> = new Set(['rate_limit_error', 'rate_limit_exceeded', 'insufficient_quota'])
const ACCESS_TYPES: ReadonlySet<string> = new Set(['authentication_error', 'permission_error', 'invalid_api_key'])
const PROVIDER_TYPES: ReadonlySet<string> = new Set(['overloaded_error', 'api_error', 'server_error', 'invalid_request_error'])

function ofStatus(status: unknown): AiFailureKind | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined
  if (status === 401 || status === 403) return 'access'
  if (status === 402 || status === 429) return 'limit'
  if (status === 408) return 'timeout'
  // A bare 404 names a ROUTE. A wrong path prefix on an OpenAI-compatible server answers it for every request, and
  // choosing another model would fix nothing; the model case needs a marker in the answer (see `hasModelMarker`).
  if (status === 404) return 'endpoint'
  return status >= 400 && status < 600 ? 'provider' : undefined
}

/** The provider's own words for "this model is not served": a code/type on the error or in its parsed `data.error`. */
function hasModelMarker(node: object): boolean {
  const o = node as { code?: unknown; type?: unknown; data?: { error?: { code?: unknown; type?: unknown } | null } | null }
  const inner = o.data && typeof o.data === 'object' ? o.data.error : undefined
  return [o.code, o.type, inner?.code, inner?.type].some(v => typeof v === 'string' && MODEL_TYPES.has(v))
}

function ofNode(node: object): AiFailureKind | undefined {
  const o = node as { statusCode?: unknown; status?: unknown; code?: unknown; type?: unknown }
  if (hasModelMarker(node)) return 'model'
  const byStatus = ofStatus(o.statusCode) ?? ofStatus(o.status)
  if (byStatus) return byStatus
  if (typeof o.code === 'string') {
    if (TIMEOUT_CODES.has(o.code)) return 'timeout'
    if (NETWORK_CODES.has(o.code)) return 'network'
  }
  if (typeof o.type === 'string') {
    if (LIMIT_TYPES.has(o.type)) return 'limit'
    if (ACCESS_TYPES.has(o.type)) return 'access'
    if (PROVIDER_TYPES.has(o.type)) return 'provider'
  }
  return undefined
}

function walk(node: unknown, depth: number, seen: WeakSet<object>): AiFailureKind | undefined {
  if (node === null || typeof node !== 'object' || depth > 5 || seen.has(node)) return undefined
  seen.add(node)
  try {
    // The SDK's retry wrapper keeps every attempt in `errors`; the last one is what the provider finally said.
    // When it says nothing structured, the earlier attempts are tried before giving up.
    if (RetryError.isInstance(node)) {
      const last = walk(node.lastError, depth + 1, seen)
      if (last) return last
      for (const inner of node.errors) { const k = walk(inner, depth + 1, seen); if (k) return k }
      return undefined
    }
    // A typed provider error carries a status when the endpoint answered; one WITHOUT a status is a transport
    // failure (the request never got a response), and the system code sits in its `cause` (ECONNREFUSED,
    // ENOTFOUND, UND_ERR_CONNECT_TIMEOUT), so the chain is followed below instead of stopping here.
    const own = ofNode(node)
    if (own) return own
    const o = node as { errors?: unknown; cause?: unknown; error?: unknown }
    if (Array.isArray(o.errors)) for (const inner of o.errors) { const k = walk(inner, depth + 1, seen); if (k) return k }
    return walk(o.cause, depth + 1, seen) ?? walk(o.error, depth + 1, seen)
  } catch {
    return undefined
  }
}

export function classifyAiFailure(err: unknown): AiFailureKind | undefined {
  return walk(err, 0, new WeakSet())
}
