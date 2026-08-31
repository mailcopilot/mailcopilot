import { describe, expect, it } from 'vitest'
import {
  ERROR_PRESENTATION_KEYS,
  ERROR_PRESENTATION_I18N_KEYS,
  classifyErrorPresentation,
  decodeErrorPresentation,
  describeErrorForLog,
  encodeErrorPresentation,
  isErrorPresentationKey,
  presentedIpcMessage,
  stripErrorPresentation,
} from './errorPresentation'

/**
 * BACKLOG §2.127 — the production symptom being closed here:
 *
 *   "Sync error: Error: Error invoking remote method 'net:inboxSummaries':
 *    AggregateError"
 *
 * observed four times in ten minutes on a live instance. `AggregateError` has
 * an empty `message` by construction, so the user was shown a type name.
 */

// tsconfig targets ES2020, so `AggregateError` and the two-argument `Error`
// constructor have no type declarations here even though the runtime (Node 22 /
// Electron 40) supports both. Reach them structurally, exactly like the
// production code does.
type AggErrCtor = new (errors: unknown[], message?: string) => Error & { errors: unknown[] }
const AggErr = (globalThis as unknown as { AggregateError: AggErrCtor }).AggregateError

function withCause<T>(err: T, cause: unknown): T {
  const target = err as { cause?: unknown }
  target.cause = cause
  return err
}

/** The exact shape ImapFlow/Node produce when every address of a host times out. */
function makeEtimedoutAggregate(): Error & { errors: unknown[] } {
  const a = Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:993'), {
    code: 'ETIMEDOUT',
    errno: -110,
    syscall: 'connect',
  })
  const b = Object.assign(new Error('connect ETIMEDOUT 203.0.113.11:993'), {
    code: 'ETIMEDOUT',
  })
  return Object.assign(new AggErr([a, b]), { code: 'ETIMEDOUT' })
}

describe('vocabulary', () => {
  it('is closed and fully translated', () => {
    expect(ERROR_PRESENTATION_KEYS).toEqual(['offline', 'timeout', 'auth', 'unknown'])
    for (const key of ERROR_PRESENTATION_KEYS) {
      expect(ERROR_PRESENTATION_I18N_KEYS[key]).toBe(`app.errors.presented.${key}`)
    }
    expect(Object.keys(ERROR_PRESENTATION_I18N_KEYS)).toHaveLength(ERROR_PRESENTATION_KEYS.length)
  })

  it('recognises only its own keys', () => {
    expect(isErrorPresentationKey('offline')).toBe(true)
    expect(isErrorPresentationKey('cert')).toBe(false)
    expect(isErrorPresentationKey(null)).toBe(false)
    expect(isErrorPresentationKey(42)).toBe(false)
  })
})

describe('classifyErrorPresentation', () => {
  it('classifies the production AggregateError [ETIMEDOUT] as a timeout', () => {
    expect(classifyErrorPresentation(makeEtimedoutAggregate())).toBe('timeout')
  })

  it('classifies an AggregateError whose inner errors carry the code but the aggregate does not', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const agg = new AggErr([inner])
    expect(agg.message).toBe('') // the whole reason this module exists
    expect(classifyErrorPresentation(agg)).toBe('offline')
  })

  it('walks a cause chain', () => {
    const root = Object.assign(new Error('getaddrinfo ENOTFOUND imap.example.com'), {
      code: 'ENOTFOUND',
    })
    const wrapped = withCause(new Error('Sync failed'), withCause(new Error('fetch headers'), root))
    expect(classifyErrorPresentation(wrapped)).toBe('offline')
  })

  it('classifies a nested AggregateError inside a cause chain', () => {
    const wrapped = withCause(new Error('Inbox summaries failed'), makeEtimedoutAggregate())
    expect(classifyErrorPresentation(wrapped)).toBe('timeout')
  })

  it('classifies bare strings', () => {
    expect(classifyErrorPresentation('connect ECONNREFUSED 203.0.113.1:993')).toBe('offline')
    expect(classifyErrorPresentation('Socket timeout')).toBe('timeout')
    expect(classifyErrorPresentation('Invalid credentials')).toBe('auth')
    expect(classifyErrorPresentation('something entirely unexpected')).toBe('unknown')
  })

  it('classifies credential rejections from structural signals, not only text', () => {
    // ImapFlow
    expect(
      classifyErrorPresentation(
        Object.assign(new Error('Command failed'), {
          authenticationFailed: true,
          serverResponseCode: 'AUTHENTICATIONFAILED',
        }),
      ),
    ).toBe('auth')
    // nodemailer / SMTP
    expect(
      classifyErrorPresentation(
        Object.assign(new Error('Username and Password not accepted'), {
          code: 'EAUTH',
          responseCode: 535,
        }),
      ),
    ).toBe('auth')
  })

  it('prefers auth over transient signals when both are present', () => {
    const agg = new AggErr([
      Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:993'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('Invalid credentials'), { authenticationFailed: true }),
    ])
    expect(classifyErrorPresentation(agg)).toBe('auth')
  })

  it('returns the neutral key — never an empty string — for null, undefined and junk', () => {
    for (const input of [null, undefined, 0, NaN, {}, [], Symbol('x'), new Error('')]) {
      const key = classifyErrorPresentation(input)
      expect(ERROR_PRESENTATION_KEYS).toContain(key)
      expect(key).toBe('unknown')
    }
  })

  it('terminates on a cyclic cause reference', () => {
    const a = new Error('outer') as Error & { cause?: unknown }
    const b = new Error('inner') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(classifyErrorPresentation(a)).toBe('unknown')

    const selfRef = new Error('self') as Error & { cause?: unknown }
    selfRef.cause = selfRef
    expect(classifyErrorPresentation(selfRef)).toBe('unknown')
  })

  it('terminates on a cyclic AggregateError tree and still classifies it', () => {
    const timeout = Object.assign(new Error('Socket timeout'), { code: 'ETIMEDOUT' })
    const agg = new AggErr([timeout])
    ;(agg.errors as unknown[]).push(agg)
    expect(classifyErrorPresentation(agg)).toBe('timeout')
  })

  it('survives errors whose getters throw', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom')
      },
      get code(): string {
        throw new Error('boom')
      },
    }
    expect(classifyErrorPresentation(hostile)).toBe('unknown')
  })

  it('does not classify a TLS trust failure as a network condition', () => {
    // Cert failures have their own recovery UI (cert:recoveryRequired); they
    // must not be flattened into "no connection".
    const err = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })
    expect(classifyErrorPresentation(err)).toBe('unknown')
  })
})

describe('presentedIpcMessage', () => {
  it('tags the message with a key derived from the object, keeping the raw text after it', () => {
    const msg = presentedIpcMessage(makeEtimedoutAggregate())
    expect(msg.startsWith('[mcerr:timeout] ')).toBe(true)
    expect(msg).toContain('AggregateError')
  })

  it('emits a bare tag when there is no text at all', () => {
    expect(presentedIpcMessage(undefined)).toBe('[mcerr:unknown]')
  })

  it('does not clip long error text — renderer consumers substring-match it', () => {
    // src/hooks/useCertRecovery.ts and src/sentry.ts both search this string;
    // clipping it would make them miss tokens that used to arrive intact.
    const msg = presentedIpcMessage(new Error(`${'x'.repeat(5000)}ECONNRESET`))
    expect(msg.endsWith('ECONNRESET')).toBe(true)
  })

  it('never throws on hostile input', () => {
    const hostile = {
      toString() {
        throw new Error('nope')
      },
    }
    expect(() => presentedIpcMessage(hostile)).not.toThrow()
    expect(presentedIpcMessage(hostile)).toBe('[mcerr:unknown]')
  })
})

describe('decodeErrorPresentation', () => {
  // The exact string Electron 40 hands the renderer (measured with a real
  // main+preload+renderer round trip): the main-process error object is gone,
  // only this text survives.
  const overTheWire = (text: string) =>
    new Error(`Error invoking remote method 'net:inboxSummaries': Error: ${text}`)

  it('recovers the key the main process attached', () => {
    expect(decodeErrorPresentation(overTheWire('[mcerr:timeout] AggregateError'))).toBe('timeout')
    expect(decodeErrorPresentation(overTheWire('[mcerr:offline] Error: socket hang up'))).toBe('offline')
    expect(decodeErrorPresentation(overTheWire('[mcerr:auth] Error: Invalid credentials'))).toBe('auth')
  })

  it('ignores a tag echoed by the server — the first tag is always ours', () => {
    const spoofed = overTheWire('[mcerr:offline] Error: login failed: [mcerr:auth] pay me')
    expect(decodeErrorPresentation(spoofed)).toBe('offline')
  })

  // §2.127 fix wave (LOW-1) — the tag is read only where the funnel can have
  // written it. These pin both halves: the positions we DO accept, and the fact
  // that a `[mcerr:…]` sequence anywhere else is just text.
  it('reads the tag in every position the funnel can produce', () => {
    // Bare (main-side, unit tests), and both stringification shapes.
    expect(decodeErrorPresentation(new Error('[mcerr:timeout] whatever'))).toBe('timeout')
    expect(decodeErrorPresentation('Error: [mcerr:auth] whatever')).toBe('auth')
    expect(decodeErrorPresentation(overTheWire('[mcerr:auth] whatever'))).toBe('auth')
    expect(decodeErrorPresentation(
      new Error("Error: Error invoking remote method 'net:sync': Error: [mcerr:offline] whatever"),
    )).toBe('offline')
    // Tag ahead of the envelope — the shape renderer unit tests construct.
    expect(decodeErrorPresentation(
      new Error("[mcerr:auth] Error invoking remote method 'ai:checkAuth': rejected"),
    )).toBe('auth')
  })

  it('does not accept a tag buried in third-party text (no funnel, no trust)', () => {
    // Never passed through handleIpc; the server simply put our token in its
    // own prose. Classification of the text decides, not the fake tag.
    const untagged = new Error('authentication failed, see [mcerr:offline] in the docs')
    expect(decodeErrorPresentation(untagged)).toBe('auth')
    const noise = new Error('unrelated failure mentioning [mcerr:auth] somewhere')
    expect(decodeErrorPresentation(noise)).toBe('unknown')
  })

  it('collapses an unknown tag instead of trusting the text around it', () => {
    expect(decodeErrorPresentation(overTheWire('[mcerr:ransom] Invalid credentials'))).toBe('unknown')
  })

  it('falls back to classification for untagged errors (preload whitelist, renderer-local)', () => {
    expect(decodeErrorPresentation(new Error('IPC channel "x" is not allowed'))).toBe('unknown')
    expect(decodeErrorPresentation(makeEtimedoutAggregate())).toBe('timeout')
    expect(decodeErrorPresentation('Connection not available')).toBe('offline')
  })

  it('always returns a key', () => {
    for (const input of [null, undefined, '', {}, 7]) {
      expect(ERROR_PRESENTATION_KEYS).toContain(decodeErrorPresentation(input))
    }
  })

  it('round-trips what the funnel produced', () => {
    for (const err of [
      makeEtimedoutAggregate(),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('nope'), { authenticationFailed: true }),
      new Error('totally novel failure'),
    ]) {
      const wire = new Error(`Error invoking remote method 'net:sync': Error: ${presentedIpcMessage(err)}`)
      expect(decodeErrorPresentation(wire)).toBe(classifyErrorPresentation(err))
    }
  })
})

describe('encode / strip', () => {
  it('encodes every key', () => {
    for (const key of ERROR_PRESENTATION_KEYS) {
      expect(encodeErrorPresentation(key)).toBe(`[mcerr:${key}]`)
    }
  })

  it('removes the tag from text shown verbatim on diagnostics screens', () => {
    expect(stripErrorPresentation('[mcerr:auth] Error: Invalid credentials')).toBe(
      'Error: Invalid credentials',
    )
    expect(stripErrorPresentation('no tag here')).toBe('no tag here')
    expect(stripErrorPresentation('' as string)).toBe('')
  })

  it('keeps the envelope it sat behind, and leaves look-alikes in text alone', () => {
    expect(
      stripErrorPresentation("Error invoking remote method 'net:testImap': Error: [mcerr:auth] LOGIN failed"),
    ).toBe("Error invoking remote method 'net:testImap': Error: LOGIN failed")
    // Not our annotation — part of what the server said, so it stays.
    expect(stripErrorPresentation('server said: see [mcerr:auth] in the manual')).toBe(
      'server said: see [mcerr:auth] in the manual',
    )
  })
})

describe('describeErrorForLog', () => {
  it('keeps the existing single-line format for a plain error', () => {
    expect(describeErrorForLog(new Error('boom'))).toBe('boom')
    expect(describeErrorForLog('plain string failure')).toBe('plain string failure')
  })

  it('recovers the cause an AggregateError hides — the log used to be empty here', () => {
    const out = describeErrorForLog(makeEtimedoutAggregate())
    expect(out).toContain('AggregateError (ETIMEDOUT)')
    expect(out).toContain('connect ETIMEDOUT 203.0.113.10:993 (ETIMEDOUT)')
    expect(out).toContain('connect ETIMEDOUT 203.0.113.11:993 (ETIMEDOUT)')
  })

  it('deduplicates repeated nodes and bounds its own length', () => {
    const inner = Object.assign(new Error('same'), { code: 'ECONNRESET' })
    const agg = new AggErr([inner, Object.assign(new Error('same'), { code: 'ECONNRESET' })])
    expect(describeErrorForLog(agg)).toBe('AggregateError | same (ECONNRESET)')

    const huge = describeErrorForLog(new Error('y'.repeat(9000)))
    expect(huge.length).toBeLessThan(2100)
  })

  it('never returns an empty string', () => {
    for (const input of [null, undefined, {}, new Error('')]) {
      expect(describeErrorForLog(input).length).toBeGreaterThan(0)
    }
  })

  it('never throws on hostile input', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom')
      },
      toString() {
        throw new Error('boom')
      },
    }
    expect(() => describeErrorForLog(hostile)).not.toThrow()
    expect(describeErrorForLog(hostile)).toBe('unknown error')
  })
})
