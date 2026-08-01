import { describe, it, expect } from 'vitest'
import { scrubUserPathsShape, scrubEmailAddressesShape, scrubEventPiiWith, scrubLogPiiWith } from './piiScrub'

const scrub = scrubUserPathsShape

describe('scrubUserPathsShape', () => {
  it('replaces the account name in POSIX home paths', () => {
    expect(scrub('/home/ivan/app/main.js')).toBe('/home/<user>/app/main.js')
    expect(scrub('/Users/ivan/Library/Application Support/MailCopilot/main.js'))
      .toBe('/Users/<user>/Library/Application Support/MailCopilot/main.js')
  })

  it('replaces the account name in Windows user paths on any drive', () => {
    expect(scrub('C:\\Users\\ivan\\AppData\\Local\\app.js')).toBe('C:\\Users\\<user>\\AppData\\Local\\app.js')
    expect(scrub('D:/Users/ivan/app.js')).toBe('D:/Users/<user>/app.js')
  })

  it('handles non-ASCII names', () => {
    expect(scrub('C:\\Users\\Иван\\AppData\\Roaming\\app.js')).toBe('C:\\Users\\<user>\\AppData\\Roaming\\app.js')
    expect(scrub('/home/иван/app.js')).toBe('/home/<user>/app.js')
  })

  // §2.82 iter2 finding 3 — the old single-token class stopped at the first
  // space, so `C:\Users\John Doe\...` shipped `Doe`. Names with spaces are the
  // NORM on Windows and macOS, not an edge case.
  it('scrubs a whole name containing spaces', () => {
    expect(scrub('C:\\Users\\John Doe\\AppData\\Local\\app.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Local\\app.js')
    expect(scrub('/Users/John Doe/Library/Logs/main.log'))
      .toBe('/Users/<user>/Library/Logs/main.log')
    expect(scrub("EACCES: permission denied, open '/home/john doe'"))
      .toBe("EACCES: permission denied, open '/home/<user>'")
  })

  it('does not run past the end of one path into the next', () => {
    expect(scrub('copy /home/ivan/a.txt /home/petr/b.txt'))
      .toBe('copy /home/<user>/a.txt /home/<user>/b.txt')
    expect(scrub('C:\\Users\\ivan\\a.txt C:\\Users\\petr\\b.txt'))
      .toBe('C:\\Users\\<user>\\a.txt C:\\Users\\<user>\\b.txt')
  })

  it('leaves paths without a user directory alone', () => {
    for (const untouched of [
      '/usr/lib/electron/resources/app.asar/main.js',
      'node:internal/modules/cjs/loader',
      'app:///assets/index.js',
      '',
    ]) {
      expect(scrub(untouched)).toBe(untouched)
    }
  })

  it('is idempotent', () => {
    for (const input of [
      '/home/ivan/app/main.js',
      'C:\\Users\\John Doe\\AppData\\Local\\app.js',
      "open '/home/john doe'",
      '/Users/ivan/x',
    ]) {
      const once = scrub(input)
      expect(scrub(once)).toBe(once)
    }
  })
})

describe('scrubEventPiiWith', () => {
  it('nulls the IP address so the server does not infer one', () => {
    const event = scrubEventPiiWith({ user: { id: 'abcd' } }, scrub) as { user: Record<string, unknown> }
    expect(event.user.ip_address).toBeNull()
    expect(event.user.id).toBe('abcd')
  })

  // The single most common real leak path: fs/OS error text, which is also
  // what Sentry renders as the issue title.
  it('scrubs the exception TEXT, not just the frames', () => {
    const event = scrubEventPiiWith({
      exception: {
        values: [{
          value: "EACCES: permission denied, open '/home/ivan/.config/MailCopilot/settings.json'",
          stacktrace: {
            frames: [{
              filename: '/home/ivan/app/main.js',
              abs_path: '/home/ivan/app/main.js',
              module: '/home/ivan/app',
              context_line: "readFileSync('/home/ivan/x')",
            }],
          },
        }],
      },
    }, scrub) as { exception: { values: Array<{ value: string; stacktrace: { frames: Array<Record<string, string>> } }> } }

    const val = event.exception.values[0]!
    expect(val.value).toBe("EACCES: permission denied, open '/home/<user>/.config/MailCopilot/settings.json'")
    expect(JSON.stringify(val.stacktrace)).not.toContain('ivan')
  })

  it('scrubs thread stacks, message, culprit and logentry', () => {
    const event = scrubEventPiiWith({
      message: 'failed reading /home/ivan/x',
      culprit: '/home/ivan/app/main.js',
      logentry: {
        message: 'open %s',
        formatted: "open '/home/ivan/x'",
        params: ['/home/ivan/x'],
      },
      threads: { values: [{ stacktrace: { frames: [{ filename: '/home/ivan/w.js' }] } }] },
    }, scrub)
    expect(JSON.stringify(event)).not.toContain('ivan')
  })

  it('scrubs breadcrumbs, extra, contexts and tags', () => {
    const event = scrubEventPiiWith({
      breadcrumbs: [
        { message: 'loaded /home/ivan/a.js' },
        { message: 'ok', data: { path: '/home/ivan/b.js', nested: { deeper: 'C:\\Users\\ivan\\c.js' } } },
      ],
      extra: { source: 'bodyIndexer', file: '/home/ivan/d.js', list: ['/home/ivan/e.js'] },
      contexts: { app: { app_path: '/home/ivan/f.js' } },
      tags: { store_path: '/home/ivan/g.json' },
    }, scrub)
    expect(JSON.stringify(event)).not.toContain('ivan')
  })

  it('leaves values that carry no path untouched', () => {
    const event = scrubEventPiiWith({
      extra: { count: 3, ok: true, name: 'imap.sync' },
      tags: { category: 'ipc_handler_error' },
    }, scrub) as { extra: Record<string, unknown>; tags: Record<string, unknown> }
    expect(event.extra).toMatchObject({ count: 3, ok: true, name: 'imap.sync' })
    expect(event.tags).toMatchObject({ category: 'ipc_handler_error' })
  })

  it('never throws on a shape it did not expect', () => {
    // Telemetry must never turn a broken assumption into a crash (§8).
    for (const weird of [null, undefined, 42, 'string', { exception: 'not-an-object' }, { breadcrumbs: 'nope' }]) {
      expect(() => scrubEventPiiWith(weird, scrub)).not.toThrow()
    }
  })

  it('terminates on a deeply nested extra payload', () => {
    // Depth/node caps exist so a pathological payload cannot stall beforeSend.
    let deep: Record<string, unknown> = { path: '/home/ivan/x' }
    for (let i = 0; i < 200; i++) deep = { next: deep }
    expect(() => scrubEventPiiWith({ extra: deep }, scrub)).not.toThrow()
  })
})

// §2.82 iter2 finding 2 — `ScrubbableEvent` did not cover `request`, the
// transaction name, or span descriptions. The renderer runs BrowserTracing and
// Electron serves the window with `loadFile`, so on a Windows per-user install
// every pageload transaction carried `C:\Users\<name>\AppData\...` in all
// three. That is the default configuration on the most common platform.
describe('scrubEventPiiWith — transaction envelope fields (finding 2)', () => {
  it('scrubs request.url', () => {
    const event = scrubEventPiiWith({
      request: { url: 'file:///C:/Users/ivan/AppData/Local/Programs/mailcopilot/index.html' },
    }, scrub) as { request: { url: string } }
    expect(event.request.url).toBe('file:///C:/Users/<user>/AppData/Local/Programs/mailcopilot/index.html')
    expect(JSON.stringify(event)).not.toContain('ivan')
  })

  it('scrubs the remaining request members whatever shape they arrive in', () => {
    const event = scrubEventPiiWith({
      request: {
        query_string: 'from=/home/ivan/a.txt',
        headers: { Referer: 'file:///home/ivan/index.html' },
        cookies: { last_path: 'C:\\Users\\ivan\\x' },
        data: { paths: ['/Users/ivan/b.txt'] },
        env: { HOME: '/home/ivan' },
      },
    }, scrub)
    expect(JSON.stringify(event)).not.toContain('ivan')
  })

  it('scrubs the transaction name', () => {
    const event = scrubEventPiiWith({
      transaction: '/C:/Users/ivan/AppData/Local/Programs/mailcopilot/index.html',
    }, scrub) as { transaction: string }
    expect(event.transaction).toBe('/C:/Users/<user>/AppData/Local/Programs/mailcopilot/index.html')
  })

  it('scrubs span descriptions and span data', () => {
    const event = scrubEventPiiWith({
      spans: [
        { description: 'GET file:///home/ivan/app/assets/index.js' },
        { description: 'resource.script', data: { 'http.url': 'file:///Users/ivan/app/x.js' } },
        'not-an-object',
      ],
    }, scrub)
    expect(JSON.stringify(event)).not.toContain('ivan')
  })

  it('still never throws on unexpected shapes for the new fields', () => {
    for (const weird of [
      { request: 'nope' },
      { request: { url: 42 } },
      { spans: 'nope' },
      { spans: [null, 7] },
      { transaction: 42 },
    ]) {
      expect(() => scrubEventPiiWith(weird, scrub)).not.toThrow()
    }
  })
})

// §2.82 iter2 finding 1, systemic half — the consent screen promises without
// qualification that email addresses are never sent, but third-party failure
// text (IMAP NO responses, Azure error_description, SMTP rejections) names the
// mailbox. Call sites are being converted to synthetic errors one at a time;
// this is the net that holds regardless of which call site produced the event.
describe('scrubEmailAddressesShape', () => {
  it('redacts addresses in free text', () => {
    expect(scrubEmailAddressesShape('LOGIN failed for ivan.petrov+work@mail.example.co.uk'))
      .toBe('LOGIN failed for <email>')
    expect(scrubEmailAddressesShape('to=a@b.io, cc=c@d.org')).toBe('to=<email>, cc=<email>')
  })

  it('is idempotent', () => {
    const once = scrubEmailAddressesShape('x ivan@example.com y')
    expect(scrubEmailAddressesShape(once)).toBe(once)
  })

  it('leaves ordinary text containing @ alone', () => {
    expect(scrubEmailAddressesShape('@types/node')).toBe('@types/node')
    expect(scrubEmailAddressesShape('root@localhost')).toBe('root@localhost')
    expect(scrubEmailAddressesShape('no at sign here')).toBe('no at sign here')
  })
})

describe('scrubEventPiiWith — address redaction', () => {
  it('redacts addresses in exception text, extra and breadcrumbs', () => {
    const event = scrubEventPiiWith({
      exception: { values: [{ value: 'NO [OVERQUOTA] mailbox ivan@example.com is full' }] },
      extra: { detail: 'recipient petr@example.org rejected' },
      breadcrumbs: [{ message: 'sent to anna@example.net' }],
    }, scrub)
    const out = JSON.stringify(event)
    expect(out).not.toContain('@example.com')
    expect(out).not.toContain('@example.org')
    expect(out).not.toContain('@example.net')
    expect(out).toContain('<email>')
  })

  it('applies both rules to the same string', () => {
    const event = scrubEventPiiWith({
      message: "EACCES open '/home/ivan/mail' while sending to ivan@example.com",
    }, scrub) as { message: string }
    expect(event.message).toBe("EACCES open '/home/<user>/mail' while sending to <email>")
  })

  it('leaves a user feedback envelope alone — the reply address is deliberate', () => {
    // Settings → About feedback: the consent screen names this as the single
    // exception to "addresses are never sent". Redacting it would break the
    // reply path the user asked for.
    const event = scrubEventPiiWith({
      type: 'feedback',
      contexts: { feedback: { contact_email: 'ivan@example.com', message: 'search is slow' } },
    }, scrub)
    expect(JSON.stringify(event)).toContain('ivan@example.com')
  })

  it('still strips the OS account name from a feedback envelope', () => {
    const event = scrubEventPiiWith({
      type: 'feedback',
      contexts: { feedback: { message: 'crash at /home/ivan/app' } },
    }, scrub)
    expect(JSON.stringify(event)).not.toContain('/home/ivan')
  })
})

// §2.82 iter4 (security finding 3) — the structured-log envelope is scrubbed by
// the same rules as an event. It does NOT pass through `beforeSend`, so before
// this helper existed the whole log surface left the process untouched.
describe('scrubLogPiiWith', () => {
  it('scrubs the message and every string attribute', () => {
    const log = {
      level: 'info',
      message: "open '/home/ivan/mail.log'",
      attributes: {
        'ai.model': '/Users/ivan/models/q4.gguf',
        'ai.owner': 'ivan@example.com',
        'ai.turns': 4,
        nested: { path: 'C:\\Users\\ivan\\AppData\\Local\\app.js' },
      },
    }

    const out = scrubLogPiiWith(log, scrub)

    expect(out.message).toBe("open '/home/<user>/mail.log'")
    expect(out.attributes['ai.model']).toBe('/Users/<user>/models/q4.gguf')
    expect(out.attributes['ai.owner']).toBe('<email>')
    expect(out.attributes['ai.turns']).toBe(4)
    expect((out.attributes.nested as { path: string }).path).toBe('C:\\Users\\<user>\\AppData\\Local\\app.js')
  })

  it('handles a boxed ParameterizedString message', () => {
    // `Sentry.logger.fmt` returns `new String(...)` with template metadata; the
    // SDK has already copied the template into attributes by this point.
    const message = new String('sync failed for /home/ivan/box') as unknown as string
    const out = scrubLogPiiWith({ level: 'warn', message }, scrub)
    expect(typeof out.message).toBe('string')
    expect(out.message).toBe('sync failed for /home/<user>/box')
  })

  it('is idempotent and never throws on odd shapes', () => {
    const once = scrubLogPiiWith({ message: '/home/ivan/a.js' }, scrub)
    expect(scrubLogPiiWith({ message: once.message }, scrub).message).toBe(once.message)
    expect(() => scrubLogPiiWith({}, scrub)).not.toThrow()
    expect(() => scrubLogPiiWith({ message: 42, attributes: 'nope' }, scrub)).not.toThrow()
    expect(() => scrubLogPiiWith(null, scrub)).not.toThrow()
  })
})
