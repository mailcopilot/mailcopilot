// Degraded-path emulation for the IMAP retry boundary, with the REAL ImapFlow
// against local sockets (no mocked constructor): what the boundary does is a
// function of the error shapes the installed library and Node really raise.
//
// Two environments, both fixed and local, neither a live tunnel:
//   1. the port refuses at once (what a dead route or a stopped server gives:
//      ECONNREFUSED, instantly, from every address of `localhost`);
//   2. the path accepts the TCP connection and then says nothing after the
//      ClientHello (TLS never completes).
// The second is bounded by the library's own connection deadline (90 s, the
// ImapFlow default; no budget is introduced here), which a fake timer clock
// advances so the test does not wait it out.
import { afterEach, describe, expect, it, vi } from 'vitest'
// imap.ts imports the SQLite layer (a native module built for Electron's ABI);
// nothing in these tests touches it.
vi.mock('../db', () => ({}))
// The REAL ImapFlow, only counted: how many connections the boundary tried.
const constructed = vi.hoisted(() => ({ count: 0 }))
vi.mock('imapflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('imapflow')>()
  class CountingImapFlow extends actual.ImapFlow {
    constructor(...args: ConstructorParameters<typeof actual.ImapFlow>) {
      super(...args)
      constructed.count++
    }
  }
  return { ...actual, ImapFlow: CountingImapFlow }
})

import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { connectImap, forceDisconnectImap, withImapRetry } from './imap'
import { isImapConnectionFailure } from '@mailcopilot/core/transportFailure'
import type { ImapConfig } from './types'

const closers: Array<() => void> = []
afterEach(() => {
  constructed.count = 0
  vi.useRealTimers()
  forceDisconnectImap()
  while (closers.length) closers.pop()!()
})

function listen(onConnection?: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      closers.push(() => socket.destroy())
      onConnection?.(socket)
    })
    closers.push(() => server.close())
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** A port nothing listens on: bind, note the number, close. */
async function refusedPort(): Promise<number> {
  const server = await listen()
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const cfgFor = (host: string, port: number): ImapConfig => ({ host, port, secure: true, user: 'degraded@test.com', pass: 'p' })

describe('IMAP retry boundary on a degraded path (real ImapFlow, local sockets)', () => {
  it('an instantly refused port is retried within the bounded budget, then surfaces the real error', async () => {
    const port = await refusedPort()
    const cfg = cfgFor('localhost', port)
    const caught = await withImapRetry(71, cfg, async () => { await connectImap(cfg) }).catch((e: unknown) => e)

    // One connection for the first attempt plus the two retries' reconnects,
    // then the failure is rethrown: bounded, not endless.
    expect(constructed.count).toBe(3)
    expect(caught).toBeInstanceOf(Error)
    // Whatever shape Node gave (a single ECONNREFUSED, or an empty-message
    // AggregateError when `localhost` resolved to several addresses), the
    // structural reader recognises it.
    expect(isImapConnectionFailure(caught)).toBe(true)
  }, 20_000)

  it('a path that accepts TCP and goes silent after ClientHello ends at the library deadline, is not retried, and is not mistaken for a refusal', async () => {
    const sawClientHello = new Promise<void>((resolveHello) => {
      void listen((socket) => { socket.once('data', () => resolveHello()) }).then((server) => {
        silentPort = (server.address() as AddressInfo).port
        serverReady()
      })
    })
    let serverReady!: () => void
    let silentPort = 0
    const ready = new Promise<void>((resolve) => { serverReady = resolve })
    await ready

    // The 90 s connection deadline is a timer inside ImapFlow; fake only the
    // timer functions so the real socket I/O below still runs.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cfg = cfgFor('127.0.0.1', silentPort)
    const outcome = withImapRetry(72, cfg, async () => { await connectImap(cfg) }).catch((e: unknown) => e)

    await sawClientHello // the TCP connection was accepted and the TLS ClientHello arrived; nothing answers
    await vi.advanceTimersByTimeAsync(90_000)
    const caught = await outcome

    expect(constructed.count).toBe(1)
    expect((caught as { code?: string }).code).toBe('CONNECT_TIMEOUT')
    // A timer that already spent its whole budget is not a fast failure to retry.
    expect(isImapConnectionFailure(caught)).toBe(false)
  }, 20_000)
})
