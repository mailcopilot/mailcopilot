/**
 * Retry policy helpers for the shared tool-calling chat stream (§2.288).
 *
 * `streamVercelChat` may re-issue a request only while NOTHING of the failed
 * attempt has reached the outside: no text chunk, no generated or executed tool
 * call, no finished step. This module owns the two pieces of that policy which
 * are pure and need tests of their own — what counts as a transient failure,
 * and a backoff wait the abort signal can cut short.
 *
 * Retryability is read from STRUCTURE, never from message text: the numeric
 * status the provider answered with, the SDK's own `isRetryable` flag, a
 * syscall `code`, or the `type` of a provider error payload. A message such as
 * "503" inside a 400 body, or the word "overloaded" in a user's own prompt
 * echoed back by an error, must not turn a permanent failure into a retry.
 */

import { APICallError, RetryError } from 'ai'

/** Statuses a provider uses for "try again": timeout, conflict, rate limit, 5xx. */
function isRetryableHttpStatus(status: unknown): boolean {
  if (typeof status !== 'number' || !Number.isInteger(status)) return false
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600)
}

/**
 * Transport codes that can surface BEFORE any response body was produced.
 * Retrying them is safe for the user's data; whether the failed call was billed
 * is a separate question the spend ledger answers (`isAmbiguousProviderFailure`).
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * `type` of an error payload a provider sends INSIDE an already-open stream
 * (an SSE `error` event), where no HTTP status exists any more: the response
 * was a 200 by then. Closed list — an unknown type is not retried.
 */
const RETRYABLE_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  'overloaded_error', // Anthropic
  'rate_limit_error', // Anthropic
  'api_error', // Anthropic internal error
  'server_error', // OpenAI-compatible
  'rate_limit_exceeded', // OpenAI-compatible
])

const MAX_ERROR_DEPTH = 5

function nodeIsRetryable(node: object): boolean {
  if (APICallError.isInstance(node)) {
    // The SDK derives `isRetryable` from the response status and lets the
    // provider override it (an explicit "do not retry" from the endpoint), so
    // the flag is the whole verdict for a typed provider error — the status is
    // deliberately NOT consulted again here.
    return node.isRetryable === true
  }
  const o = node as { statusCode?: unknown; status?: unknown; code?: unknown; type?: unknown }
  if (isRetryableHttpStatus(o.statusCode) || isRetryableHttpStatus(o.status)) return true
  if (typeof o.code === 'string' && RETRYABLE_TRANSPORT_CODES.has(o.code)) return true
  return typeof o.type === 'string' && RETRYABLE_PROVIDER_ERROR_TYPES.has(o.type)
}

function walk(node: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (node === null || typeof node !== 'object' || depth > MAX_ERROR_DEPTH) return false
  if (seen.has(node)) return false
  seen.add(node)
  try {
    // The SDK's own retry layer already gave up here, wherever it is nested.
    if (RetryError.isInstance(node)) return false
    if (nodeIsRetryable(node)) return true
    // A typed provider error carries the endpoint's own verdict; an attached
    // cause does not overrule an explicit "do not retry".
    if (APICallError.isInstance(node)) return false
    const o = node as { errors?: unknown; cause?: unknown; error?: unknown }
    if (Array.isArray(o.errors) && o.errors.some(inner => walk(inner, depth + 1, seen))) return true
    if (walk(o.cause, depth + 1, seen)) return true
    // A provider payload wrapped as `{ error: { type, message } }`.
    return walk(o.error, depth + 1, seen)
  } catch {
    // An exotic thrown value with throwing getters is "not retryable" — the
    // safe direction, and the caller is inside a catch handler.
    return false
  }
}

/**
 * Is this failure a transient one worth another attempt?
 *
 * Only a question about the ERROR. Whether a retry is still allowed at all
 * (nothing may have reached the outside) is the caller's condition, and the two
 * must both hold.
 *
 * A `RetryError` means the SDK's own retry layer already tried and gave up, so
 * it is terminal here: retrying it again would multiply the request count
 * (the SDK's default is three calls per `streamText`) for no new information.
 * Cancellation is never retryable.
 */
export function isRetryableStreamFailure(err: unknown): boolean {
  try {
    if (RetryError.isInstance(err)) return false
    if (err instanceof Error && err.name === 'AbortError') return false
  } catch {
    return false
  }
  return walk(err, 0, new WeakSet())
}

/**
 * Turn whatever a stream `error` part carried into an `Error` with a readable
 * message. The part's payload is `unknown` by contract: providers put a real
 * `Error` there on a transport failure, but a plain `{ type, message }` object
 * for an in-stream error event, and `String()` of that is "[object Object]".
 * The original value is kept as `cause`, so classification still sees it.
 */
export function toStreamError(raw: unknown): Error {
  try {
    if (raw instanceof Error) return raw
  } catch {
    // A thrown value whose prototype probe throws cannot be inspected at all;
    // downstream code that does `err instanceof Error` must not meet it raw.
    return new Error('AI provider stream error')
  }
  return Object.assign(new Error(streamErrorText(raw)), { cause: raw })
}

function streamErrorText(raw: unknown): string {
  try {
    if (typeof raw === 'string' && raw) return raw
    if (raw !== null && typeof raw === 'object') {
      const o = raw as { message?: unknown; error?: unknown; type?: unknown }
      if (typeof o.message === 'string' && o.message) return o.message
      if (o.error !== null && typeof o.error === 'object') {
        const inner = (o.error as { message?: unknown }).message
        if (typeof inner === 'string' && inner) return inner
      }
      if (typeof o.type === 'string' && o.type) return o.type
    }
  } catch { /* fall through to the neutral text */ }
  return 'AI provider stream error'
}

/**
 * Wait `ms`, or until `signal` aborts, whichever comes first.
 *
 * Resolves `true` only when the full wait elapsed with the signal still clear —
 * the one case where starting another attempt is allowed. Resolves `false` on
 * an abort that happened before or during the wait, with the timer cleared and
 * the listener removed, so a cancelled request neither lingers for the length
 * of the backoff nor builds one more attempt on an already-cancelled signal.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(!signal.aborted)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The retry gate's authoritative half: a fence around the tools that execute
 * LOCALLY, one per attempt.
 *
 * Stream parts alone cannot carry the guarantee "a replay never runs a tool
 * twice". The SDK starts a tool on its own, upstream of whoever reads the
 * stream, so a tool can still be queued behind a part the consumer has already
 * acted on. Our own tool handlers are the one place that decision can be made
 * without knowing the SDK's timing:
 *
 *  - a tool that STARTS while the attempt is open raises `progressed`, so the
 *    retry decision (which reads it) refuses the retry;
 *  - once the attempt is `close()`d — the first thing its failure handler does,
 *    before it reads `progressed` — a tool that tries to start is refused, and
 *    never reaches its handler. JS runs the two sides on one thread, so every
 *    start is either seen by the decision or refused: none can slip between.
 *
 * Each attempt wraps the toolset with its own fence, so a late start from an
 * abandoned attempt meets ITS closed fence rather than the next attempt's open
 * one. Tools without an `execute` (provider-executed ones, whose execution is
 * observed rather than owned) pass through untouched.
 */
/** A local tool call that began executing under a fence. */
export interface StartedTool {
  toolName: string
  /** The SDK's id for the call (second `execute` argument); absent only for a non-SDK caller. */
  toolCallId?: string
  input: unknown
}

export interface AttemptFence {
  /** True once a local tool started or a caller noted visible progress. */
  readonly progressed: boolean
  /** Record progress that did not come from a tool start (text, a tool call part, a step). */
  noteProgress(): void
  /** Every local tool that started under this fence, in start order. */
  startedTools(): ReadonlyArray<StartedTool>
  /** End the attempt: later tool starts are refused. Idempotent. */
  close(): void
  wrap<T extends Record<string, unknown>>(tools: T): T
}

export function createAttemptFence(): AttemptFence {
  let progressed = false
  let closed = false
  const started: StartedTool[] = []
  return {
    get progressed() { return progressed },
    noteProgress() { progressed = true },
    startedTools: () => started,
    close() { closed = true },
    wrap<T extends Record<string, unknown>>(tools: T): T {
      const wrapped: Record<string, unknown> = {}
      for (const [name, tool] of Object.entries(tools)) {
        const execute = (tool as { execute?: unknown } | null)?.execute
        if (typeof execute !== 'function') {
          wrapped[name] = tool
          continue
        }
        wrapped[name] = {
          ...(tool as object),
          execute: (...args: unknown[]) => {
            if (closed) throw new Error('AI attempt was abandoned; the tool was not run')
            progressed = true
            const callId = (args[1] as { toolCallId?: unknown } | undefined)?.toolCallId
            started.push({ toolName: name, toolCallId: typeof callId === 'string' ? callId : undefined, input: args[0] })
            return (execute as (...a: unknown[]) => unknown).apply(tool, args)
          },
        }
      }
      return wrapped as T
    },
  }
}

/**
 * What may be logged about a stream error: its class name and the HTTP status,
 * nothing else. A typed provider error also carries the request body (the whole
 * prompt, with the email content inside it), the URL and the response body, and
 * the SDK's own default handler prints the error object — all of which must stay
 * out of every log and out of stderr.
 */
export function describeStreamErrorForLog(err: unknown): string {
  try {
    const name = err instanceof Error && typeof err.name === 'string' && err.name ? err.name : typeof err
    const status = (err as { statusCode?: unknown } | null)?.statusCode
    return typeof status === 'number' && Number.isFinite(status) ? `${name} status=${status}` : name
  } catch {
    return 'unknown error'
  }
}
