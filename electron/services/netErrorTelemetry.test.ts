import { describe, it, expect, vi, beforeEach } from 'vitest'

// electron-log pulls the Electron runtime; the module only needs a sink.
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
// The real sentry.ts imports @sentry/node + metrics; the capture seam is
// injected in every assertion below, so the default only has to exist.
vi.mock('../sentry', () => ({ captureException: vi.fn() }))

import {
  reportSanitizedNetError,
  classifyNetError,
  sanitizeNetErrorContext,
  __resetNetErrorTelemetryRepeatGate,
} from './netErrorTelemetry'
import { imapAuthBackoffError } from '../../packages/net/authLoginLatch'

// The repeat gate is process-wide by design (it throttles a repeating failure
// across every caller). Reset it per test so one case cannot suppress another's
// identical payload.
beforeEach(() => { __resetNetErrorTelemetryRepeatGate() })

/**
 * §2.82 iter4 (security finding 2) — the packages/net error seam is the PII
 * boundary, not a pass-through.
 *
 * The fixtures below reproduce what an IMAP server actually controls: the
 * error TEXT, the response text, the executed command (which names the
 * mailbox), and the response code. None of it may reach Sentry — while the
 * diagnostic value (error class + source) must survive.
 */

// Strings a server can put into an error. Every assertion below checks the
// whole serialized payload against these.
const FOLDER = 'INBOX/Проекты/Иванов'
const SUBJECT = 'Q3 payroll spreadsheet'
const ADDRESS = 'ivan.petrov@example.com'

function captureSpy() {
  const calls: Array<{ error: Error; context: Record<string, unknown> }> = []
  return {
    calls,
    capture: (error: Error, context: Record<string, unknown>) => { calls.push({ error, context }) },
  }
}

function serialize(call: { error: Error; context: Record<string, unknown> }): string {
  return JSON.stringify({
    name: call.error.name,
    message: call.error.message,
    stack: call.error.stack,
    context: call.context,
  })
}

describe('reportSanitizedNetError — server-controlled text never leaves', () => {
  it('drops the folder name, subject and address from an IMAP command failure', () => {
    const spy = captureSpy()
    // Shape of a real ImapFlow tagged-failure error.
    const err = Object.assign(new Error('Command failed'), {
      responseText: `NO [NONEXISTENT] Mailbox ${FOLDER} does not exist (${SUBJECT})`,
      executedCommand: `A7 SELECT "${FOLDER}"`,
      serverResponseCode: 'NONEXISTENT',
      responseStatus: 'NO',
    })

    reportSanitizedNetError('imap.sync', err, { folder_role: 'inbox', provider: 'gmail' }, { capture: spy.capture })

    expect(spy.calls).toHaveLength(1)
    const payload = serialize(spy.calls[0])
    expect(payload).not.toContain(FOLDER)
    expect(payload).not.toContain('Проекты')
    expect(payload).not.toContain(SUBJECT)
    expect(payload).not.toContain('Command failed')
    // ...while the class survives.
    expect(spy.calls[0].context.error_class).toBe('mailbox')
    expect(spy.calls[0].context.source).toBe('imap.sync')
    expect(spy.calls[0].error.name).toBe('NetError')
  })

  it('drops the mailbox address from an authentication failure but keeps the class', () => {
    const spy = captureSpy()
    const err = Object.assign(new Error(`AUTHENTICATIONFAILED for ${ADDRESS}: invalid credentials`), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
    })

    reportSanitizedNetError('imap.idle', err, { provider: 'outlook', exit_reason: 'auth' }, { capture: spy.capture })

    const payload = serialize(spy.calls[0])
    expect(payload).not.toContain(ADDRESS)
    expect(payload).not.toContain('example.com')
    expect(spy.calls[0].context.error_class).toBe('auth')
    expect(spy.calls[0].context.exit_reason).toBe('auth')
    expect(spy.calls[0].context.provider).toBe('outlook')
  })

  it('does not forward a spoofed error name or a nested cause message', () => {
    const spy = captureSpy()
    const cause = new Error(`quota exceeded for ${ADDRESS} in ${FOLDER}`)
    const err = Object.assign(new Error('outer'), { cause })
    err.name = ADDRESS // `name` is a writable property — never trusted

    reportSanitizedNetError('smtp.send', err, undefined, { capture: spy.capture })

    const payload = serialize(spy.calls[0])
    expect(payload).not.toContain(ADDRESS)
    expect(payload).not.toContain(FOLDER)
    expect(spy.calls[0].context.error_kind).toBe('Error')
  })

  it('keeps a TLS trust failure classified as cert', () => {
    const spy = captureSpy()
    const err = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })

    reportSanitizedNetError('imap.idle', err, { exit_reason: 'cert' }, { capture: spy.capture })

    expect(spy.calls[0].context.error_class).toBe('cert')
  })

  it('collapses an unrecognised source to a literal', () => {
    const spy = captureSpy()
    reportSanitizedNetError(`imap.${FOLDER}`, new Error('x'), undefined, { capture: spy.capture })
    const payload = serialize(spy.calls[0])
    expect(payload).not.toContain(FOLDER)
    expect(spy.calls[0].context.source).toBe('unknown')
  })
})

describe('reportSanitizedNetError — noise and robustness', () => {
  it('drops transient network conditions against the RAW error', () => {
    const spy = captureSpy()
    // Sanitising first would hide `ECONNRESET` from beforeSend's filter, so the
    // classifier has to run here, on the original error and its cause chain.
    reportSanitizedNetError('imap.idle', new Error('Socket timeout'), undefined, { capture: spy.capture })
    reportSanitizedNetError('imap.idle', Object.assign(new Error('wrapped'), { cause: new Error('ECONNRESET') }), undefined, { capture: spy.capture })
    expect(spy.calls).toHaveLength(0)
  })

  it('still reports a non-transient failure', () => {
    const spy = captureSpy()
    reportSanitizedNetError('imap.sync', new Error('mailbox.exists_not_numeric'), undefined, { capture: spy.capture })
    expect(spy.calls).toHaveLength(1)
  })

  it('never throws — not on a broken capture sink, not on an exotic error', () => {
    const throwing = () => { throw new Error('sentry is down') }
    expect(() => reportSanitizedNetError('imap.idle', new Error('boom'), undefined, { capture: throwing })).not.toThrow()
    expect(() => reportSanitizedNetError('imap.idle', undefined, undefined, { capture: () => {} })).not.toThrow()
    expect(() => reportSanitizedNetError('imap.idle', 'a string failure', undefined, { capture: () => {} })).not.toThrow()
  })
})

describe('reportSanitizedNetError — repeat gate', () => {
  /** The failure a wrong password produces on the sync path, over and over. */
  function authErr(): Error {
    return Object.assign(new Error('Authentication failed'), { serverResponseCode: 'AUTHENTICATIONFAILED' })
  }

  it('transmits the first occurrence and drops identical repeats', () => {
    const spy = captureSpy()
    let now = 1_000_000
    for (let i = 0; i < 50; i++) {
      reportSanitizedNetError('imap.sync', authErr(), { provider: 'other' }, { capture: spy.capture, now: () => now })
      now += 5_000
    }
    // 50 failures over ~4 minutes — one event, not fifty. This is the shape of
    // the incident: 2060 identical captures from one mailbox in eight days.
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].context.error_class).toBe('auth')
    expect(spy.calls[0].context.suppressed).toBe(0)
  })

  it('carries the number of suppressed repeats on the next transmitted event', () => {
    // Suppression must not cost the FREQUENCY: a dropped event is not
    // aggregated by Sentry, it never arrives, so the count travels with the
    // next one that does.
    const spy = captureSpy()
    let now = 1_000_000
    for (let i = 0; i <= 30; i++) {
      reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now: () => now })
      now += 10_000
    }
    expect(spy.calls).toHaveLength(2)
    expect(spy.calls[0].context.suppressed).toBe(0)
    // 31 reports, 10s apart: the 1st goes out, the 29 inside the 5-minute
    // window are counted, and the one at t=300s carries their count.
    expect(spy.calls[1].context.suppressed).toBe(29)
    // The counter restarts after it has been reported.
    now += 5 * 60 * 1000
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now: () => now })
    expect(spy.calls[2].context.suppressed).toBe(0)
  })

  it('never takes the suppressed count from a caller', () => {
    const spy = captureSpy()
    reportSanitizedNetError(
      'imap.sync',
      authErr(),
      { suppressed: 9999 } as unknown as Record<string, string | number | boolean>,
      { capture: spy.capture },
    )
    // `suppressed` is not in the context allowlist, so the caller's value is
    // dropped like any other unknown key and ours is the one transmitted.
    expect(spy.calls[0].context.suppressed).toBe(0)
    expect(spy.calls[0].context.context_dropped).toBe(1)
  })

  it('never delays a different failure mode behind a repeating one', () => {
    const spy = captureSpy()
    const now = () => 1_000_000
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now })
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now })
    // Different source, different class, different context — each is its own
    // signature and each goes out immediately.
    reportSanitizedNetError('imap.idle', authErr(), undefined, { capture: spy.capture, now })
    reportSanitizedNetError('imap.sync', Object.assign(new Error('x'), { serverResponseCode: 'OVERQUOTA' }), undefined, { capture: spy.capture, now })
    reportSanitizedNetError('imap.sync', authErr(), { provider: 'gmail' }, { capture: spy.capture, now })
    expect(spy.calls).toHaveLength(4)
  })

  it('reopens after the window so a still-broken account stays visible', () => {
    const spy = captureSpy()
    let now = 1_000_000
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now: () => now })
    now += 5 * 60 * 1000 - 1
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now: () => now })
    expect(spy.calls).toHaveLength(1)
    now += 1
    reportSanitizedNetError('imap.sync', authErr(), undefined, { capture: spy.capture, now: () => now })
    expect(spy.calls).toHaveLength(2)
  })

  it('classifies the connection boundary\'s own auth backoff refusal as auth', () => {
    const spy = captureSpy()
    const err = imapAuthBackoffError(7, 3_540_000)
    expect(classifyNetError(err)).toBe('auth')
    reportSanitizedNetError('imap.sync', err, undefined, { capture: spy.capture })
    expect(spy.calls).toHaveLength(1)
    // Still synthetic: the account id in the local message does not travel.
    expect(serialize(spy.calls[0])).not.toContain('#7')
  })

  it('evicts the oldest signature once the bounded map exceeds its limit', () => {
    // The gate is a Map with no TTL sweep — only a size cap (REPEAT_KEY_LIMIT
    // = 50, insertion-ordered eviction of the oldest). Undetected by every
    // case above, which uses at most a handful of distinct signatures: remove
    // the `if (lastCaptured.size > REPEAT_KEY_LIMIT)` eviction block and this
    // is the only assertion here that goes red — everything else keeps
    // passing because an unbounded map behaves identically to a bounded one
    // until it is actually filled past the bound.
    const spy = captureSpy()
    const now = () => 1_000_000
    // 50 distinct signatures, `attempt` (an allowlisted numeric context key)
    // as the discriminator — fills the map to exactly its cap.
    for (let i = 0; i < 50; i++) {
      reportSanitizedNetError('imap.sync', authErr(), { attempt: i }, { capture: spy.capture, now })
    }
    expect(spy.calls).toHaveLength(50)

    // A 51st distinct signature must evict the OLDEST one (attempt=0) to stay
    // within the cap.
    reportSanitizedNetError('imap.sync', authErr(), { attempt: 50 }, { capture: spy.capture, now })
    expect(spy.calls).toHaveLength(51)

    // The evicted signature is no longer remembered, so — still well inside
    // the 5-minute window — it transmits again as if it were new.
    reportSanitizedNetError('imap.sync', authErr(), { attempt: 0 }, { capture: spy.capture, now })
    expect(spy.calls).toHaveLength(52)

    // A signature that was never evicted (attempt=49, inserted right before
    // the one that triggered eviction) stays suppressed.
    reportSanitizedNetError('imap.sync', authErr(), { attempt: 49 }, { capture: spy.capture, now })
    expect(spy.calls).toHaveLength(52)
  })
})

describe('sanitizeNetErrorContext', () => {
  it('passes allowlisted keys with valid values', () => {
    const { safe, dropped } = sanitizeNetErrorContext({
      provider: 'gmail',
      folder_role: 'sent',
      exit_reason: 'auth_refresh_exhausted',
      size_bucket: '10-100KB',
      has_attachments: true,
      changed_since_present: false,
      attempt: 3,
      consecutive: 2,
    })
    expect(safe).toEqual({
      provider: 'gmail',
      folder_role: 'sent',
      exit_reason: 'auth_refresh_exhausted',
      size_bucket: '10-100KB',
      has_attachments: true,
      changed_since_present: false,
      attempt: 3,
      consecutive: 2,
    })
    expect(dropped).toBe(0)
  })

  it('drops keys outside the allowlist even when the value looks harmless', () => {
    const { safe, dropped } = sanitizeNetErrorContext({ folder: 'INBOX', subject: SUBJECT, host: 'imap.example.com' })
    expect(safe).toEqual({})
    expect(dropped).toBe(3)
  })

  it('drops allowlisted keys whose value is not the expected enum or shape', () => {
    const { safe, dropped } = sanitizeNetErrorContext({
      provider: FOLDER,
      folder_role: 'INBOX/Work',
      exit_reason: `failed for ${ADDRESS}`,
      size_bucket: 'Re: payroll',
    })
    expect(safe).toEqual({})
    expect(dropped).toBe(4)
  })

  it('clamps counters instead of forwarding arbitrary numbers', () => {
    expect(sanitizeNetErrorContext({ attempt: -5 }).safe).toEqual({ attempt: 0 })
    expect(sanitizeNetErrorContext({ consecutive: 9e12 }).safe).toEqual({ consecutive: 10_000 })
    expect(sanitizeNetErrorContext({ attempt: Number.NaN }).safe).toEqual({})
  })

  it('ignores undefined values without counting them as dropped', () => {
    expect(sanitizeNetErrorContext({ provider: undefined })).toEqual({ safe: {}, dropped: 0 })
  })
})

// electron/main.ts cannot be imported in a unit test (module-level side
// effects), so the wiring itself — the part that regressed — is asserted
// against the source, the same trade-off as main.settingsClamp.test.ts.
describe('main.ts net error bridge', () => {
  it('routes setNetErrorReporter through the sanitizer, never the raw error', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8')
    const start = source.indexOf('setNetErrorReporter((source, err, context) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('})', start))
    expect(body).toContain('reportSanitizedNetError(source, err, context)')
    // The pre-fix bridge: `captureException(err, { source, ...context })`.
    expect(body).not.toContain('captureException')
  })
})

describe('classifyNetError', () => {
  it('returns a member of the closed set for arbitrary server text', () => {
    const closed = ['cert', 'auth', 'permission', 'quota', 'mailbox', 'throttled', 'timeout', 'connection', 'protocol', 'unknown']
    for (const fixture of [
      new Error(FOLDER),
      new Error(ADDRESS),
      Object.assign(new Error('x'), { code: FOLDER }),
      Object.assign(new Error('x'), { serverResponseCode: SUBJECT }),
      Object.assign(new Error('x'), { responseStatus: FOLDER }),
      'plain string',
      undefined,
      null,
    ]) {
      expect(closed).toContain(classifyNetError(fixture))
    }
  })

  it('maps the codes ImapFlow sets itself', () => {
    expect(classifyNetError(Object.assign(new Error('x'), { code: 'ETHROTTLE' }))).toBe('throttled')
    expect(classifyNetError(Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' }))).toBe('timeout')
    expect(classifyNetError(Object.assign(new Error('x'), { code: 'NoConnection' }))).toBe('connection')
    expect(classifyNetError(Object.assign(new Error('x'), { serverResponseCode: 'OVERQUOTA' }))).toBe('quota')
    expect(classifyNetError(Object.assign(new Error('x'), { serverResponseCode: 'NOPERM' }))).toBe('permission')
    expect(classifyNetError(Object.assign(new Error('x'), { responseStatus: 'BAD' }))).toBe('protocol')
  })
})
