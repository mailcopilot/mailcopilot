/**
 * §2.127 — renderer-side error presentation helper.
 *
 * The classification itself is tested in packages/core/errorPresentation.test.ts.
 * What is tested here is the renderer contract on top of it: which value wins
 * (our own translated copy vs. the closed vocabulary), and that nothing a third
 * party controls can reach the return value.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { ERROR_PRESENTATION_KEYS } from '@mailcopilot/core'
import {
  TranslatedError,
  presentedError,
  readIpcFailureTag,
  isIpcFailureNoise,
  ipcFailureLabel,
} from './errorPresentation'

/** Stand-in for i18next's `t`: returns the key so assertions name the bucket. */
const t = ((key: string) => `<${key}>`) as unknown as Parameters<typeof presentedError>[0]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('presentedError', () => {
  it('maps a tagged IPC rejection to the sentence for that tag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error(
      "[mcerr:offline] Error invoking remote method 'net:inboxSummaries': AggregateError",
    )
    expect(presentedError(t, err)).toBe('<app.errors.presented.offline>')
  })

  it.each([
    ['auth', '[mcerr:auth] 535 5.7.8 Bad credentials'],
    ['timeout', '[mcerr:timeout] ETIMEDOUT'],
    ['unknown', '[mcerr:unknown] something'],
  ])('maps the %s tag to its own sentence', (bucket, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(presentedError(t, new Error(message))).toBe(`<app.errors.presented.${bucket}>`)
  })

  it('falls back to the generic sentence for an untagged rejection', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(presentedError(t, new Error('something went sideways'))).toBe(
      '<app.errors.presented.unknown>',
    )
  })

  it('never returns the third-party text itself', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const hostile = new Error('[mcerr:offline] <img src=x onerror=alert(1)> mailbox quota exceeded')
    const shown = presentedError(t, hostile)
    expect(shown).not.toContain('onerror')
    expect(shown).not.toContain('quota')
    expect(shown).not.toContain('mcerr')
  })

  it('handles null, undefined and non-Error values without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const value of [null, undefined, 42, { message: {} }, Symbol('x')]) {
      expect(presentedError(t, value)).toBe('<app.errors.presented.unknown>')
    }
  })

  it('logs the verdict, never the raw value', () => {
    // Console output is a Sentry breadcrumb source in the renderer (default
    // integrations are on), so anything printed here can leave the machine with
    // the next event. The raw text after `[mcerr:*]` is third-party prose.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('[mcerr:auth] raw server prose')
    presentedError(t, err)
    expect(spy).toHaveBeenCalledWith('[ipc-error]', 'auth')
    expect(spy).not.toHaveBeenCalledWith('[ipc-error]', err)
  })

  it.each([
    ['a tagged rejection', new Error('[mcerr:offline] mailbox /home/user quota exceeded')],
    ['an untagged rejection', new Error('550 5.7.1 relay denied for bob@example.com')],
    ['a bare string', 'unexpected prose from a server'],
    ['an object', { message: 'nested prose', code: 'EXOTIC' }],
  ])('never hands %s to the console verbatim', (_label, value) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    presentedError(t, value)
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe('string')
        // Only our own literal plus one closed-vocabulary key may be printed.
        expect(['[ipc-error]', 'translated', ...ERROR_PRESENTATION_KEYS]).toContain(arg)
      }
    }
  })
})

describe('presentedError — TranslatedError passthrough', () => {
  it('returns our own already-translated copy verbatim', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(presentedError(t, new TranslatedError('Не удалось подключиться'))).toBe(
      'Не удалось подключиться',
    )
  })

  it('falls back to the vocabulary when the marker carries no message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(presentedError(t, new TranslatedError(''))).toBe('<app.errors.presented.unknown>')
  })

  it('does not pass through a plain Error that merely looks like our copy', () => {
    // A server echoing our wording back must not be able to impersonate the
    // marker: the discriminator is `instanceof`, not the text.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const impostor = new Error('Не удалось подключиться')
    expect(presentedError(t, impostor)).toBe('<app.errors.presented.unknown>')
  })

  it('does not pass through an object that merely claims the name', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const impostor = new Error('trust me')
    impostor.name = 'TranslatedError'
    expect(presentedError(t, impostor)).toBe('<app.errors.presented.unknown>')
  })
})

/**
 * The telemetry half of the same boundary: `readIpcFailureTag` is what tells
 * `src/sentry.ts` that a rejection carries the main-process verdict and that
 * its tail is therefore third-party prose.
 */
describe('readIpcFailureTag', () => {
  it('reads the verdict and the channel out of a wrapped IPC rejection', () => {
    const tag = readIpcFailureTag(
      new Error(
        "Error invoking remote method 'tls:getServerCert': Error: [mcerr:auth] 535 Bad credentials",
      ),
    )
    expect(tag).toEqual({ key: 'auth', channel: 'tls:getServerCert' })
  })

  it.each([
    ['offline', "Error invoking remote method 'net:inboxSummaries': Error: [mcerr:offline] AggregateError"],
    ['timeout', "Error invoking remote method 'sync:run': Error: [mcerr:timeout] ETIMEDOUT"],
    ['unknown', "Error invoking remote method 'ai:ask': Error: [mcerr:unknown] weird"],
  ])('recognises the %s verdict', (key, message) => {
    expect(readIpcFailureTag(new Error(message))?.key).toBe(key)
  })

  it('reads a tag written without the Electron envelope (main-side value)', () => {
    expect(readIpcFailureTag('[mcerr:auth] 535')).toEqual({ key: 'auth', channel: null })
  })

  it('returns null for a rejection that never passed through the funnel', () => {
    // Guard against over-capture: ordinary renderer errors must keep their own
    // message, stack and extras in Sentry.
    for (const value of [
      new Error('TypeError: cannot read property foo of undefined'),
      new Error("Error invoking remote method 'accounts:list': Error: db locked"),
      'plain string failure',
      { message: 'object failure' },
      null,
      undefined,
      42,
    ]) {
      expect(readIpcFailureTag(value)).toBeNull()
    }
  })

  it('is not fooled by whitespace into calling an untagged error tagged', () => {
    // Detection is "strip removed something beyond its own whitespace
    // normalisation". Comparing against the RAW text instead of the normalised
    // one would classify every multi-space or padded message as tagged and
    // silently swallow real renderer errors.
    for (const value of ['  db   locked \n', '\tqueue  full', 'two  spaces here']) {
      expect(readIpcFailureTag(new Error(value))).toBeNull()
    }
  })

  it('treats a tag echoed by a server as untagged when it is not in first position', () => {
    // Only the funnel can write at position 0. A server quoting our tag back
    // inside its own prose must not be able to claim a verdict.
    expect(readIpcFailureTag(new Error('550 rejected: see [mcerr:auth] in the manual'))).toBeNull()
  })

  it('still reads the funnel tag when a server echoes a second one', () => {
    // The dangerous direction: a hostile server appends `[mcerr:auth]` hoping
    // the detector gives up and lets the raw text through. First position wins.
    const tag = readIpcFailureTag(
      new Error("Error invoking remote method 'net:trustCert': Error: [mcerr:offline] bad [mcerr:auth] news"),
    )
    expect(tag?.key).toBe('offline')
  })

  it('collapses an unknown tag key instead of falling back to the text', () => {
    const tag = readIpcFailureTag(new Error('[mcerr:bogus] 535 authentication failed'))
    expect(tag).toEqual({ key: 'unknown', channel: null })
  })

  it('drops a channel that does not look like one of ours', () => {
    // A channel is only reported when it matches the narrow shape of our own
    // channel names; anything else is omitted rather than transmitted.
    const tag = readIpcFailureTag(
      new Error("Error invoking remote method 'quota exceeded for bob@example.com': Error: [mcerr:auth] x"),
    )
    expect(tag).toEqual({ key: 'auth', channel: null })
  })

  it('never throws on values with hostile getters', () => {
    const hostile = { get message(): string { throw new Error('boom') } }
    expect(() => readIpcFailureTag(hostile)).not.toThrow()
  })
})

describe('isIpcFailureNoise / ipcFailureLabel', () => {
  it('classifies network state as noise and app failures as reportable', () => {
    expect(isIpcFailureNoise({ key: 'offline', channel: null })).toBe(true)
    expect(isIpcFailureNoise({ key: 'timeout', channel: null })).toBe(true)
    expect(isIpcFailureNoise({ key: 'auth', channel: null })).toBe(false)
    expect(isIpcFailureNoise({ key: 'unknown', channel: null })).toBe(false)
  })

  it('builds the label from the closed set only', () => {
    expect(ipcFailureLabel({ key: 'auth', channel: 'net:trustCert' })).toBe('ipc_net:trustCert_auth')
    expect(ipcFailureLabel({ key: 'unknown', channel: null })).toBe('ipc_unknown_unknown')
  })
})
