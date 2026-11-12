// @vitest-environment jsdom
import net from 'node:net'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMailOpenOwnership } from './useMailOpenOwnership'
import { raceWithOpenBudget } from '../../electron/services/openBudget'

/**
 * §2.308 acceptance, renderer half: opening a message over a degraded path
 * (TCP connects, TLS hangs) must never leave the pane on "Loading". The path is
 * emulated for real: a local TCP server accepts the connection and stays silent
 * after the ClientHello. The wait is ended by the PRODUCTION open budget
 * (`raceWithOpenBudget`, the helper `net:messageDetails` uses; scaled down only
 * through its `timeoutMs` parameter), and the handler's answer to an expired
 * budget — cached-headers details marked `offlineFallback`, see
 * `electron/services/openBudget.real.test.ts` for the main half against the real
 * ImapFlow — is what the pane receives. Instant ECONNREFUSED / ENETUNREACH are
 * the supported environment, not an anomaly, and reach the pane as failures.
 * Interplay with a sync of the same folder is pinned in useMailOpenOwnership.test.ts.
 */
const BUDGET_MS = 150

let server: net.Server
let sockets: net.Socket[] = []
let port = 0

beforeEach(async () => {
  sockets = []
  server = net.createServer(sock => { sockets.push(sock); sock.on('data', () => { /* silent after ClientHello */ }); sock.on('error', () => {}) })
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  for (const s of sockets) s.destroy()
  await new Promise<void>(res => server.close(() => res()))
})

/** A TLS connect with no timeout of its own: against the silent server it never settles. */
function tlsOpen(targetPort: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port: targetPort })
    sock.on('secureConnect', () => { sock.destroy(); resolve('details') })
    sock.on('error', reject)
    sock.on('close', () => reject(new Error('socket closed')))
    cleanupSockets.push(() => sock.destroy())
  })
}
const cleanupSockets: Array<() => void> = []

/** What the open handler does: race the fetch against the budget, answer a timeout from the cache. */
async function openWithBudget(targetPort: number): Promise<string> {
  const outcome = await raceWithOpenBudget(() => tlsOpen(targetPort), BUDGET_MS)
  return outcome.kind === 'ok' ? outcome.value : 'cached-headers fallback (offlineFallback)'
}

interface Pane { details: string | null; loading: boolean; error: string | null }

async function openAgainst(request: () => Promise<string>): Promise<Pane> {
  const { result } = renderHook(() => useMailOpenOwnership())
  const pane: Pane = { details: null, loading: false, error: null }
  const ticket = result.current.beginOpen()
  pane.loading = true
  const run = result.current.run(ticket, request, {
    onApplied: d => { pane.details = d },
    onFailed: e => { pane.error = (e as Error).message },
    onDiscarded: () => {},
    releaseLoading: () => { pane.loading = false },
  })
  await act(async () => { await run })
  return pane
}

describe('open over a degraded path never leaves an endless loading (§2.308)', () => {
  it('TLS hangs after ClientHello: the budget expires, the fallback renders and loading is released', async () => {
    const started = Date.now()
    const pane = await openAgainst(() => openWithBudget(port))
    expect(Date.now() - started).toBeLessThan(BUDGET_MS * 10)
    expect(pane).toEqual({ details: 'cached-headers fallback (offlineFallback)', loading: false, error: null })
    expect(sockets.length).toBe(1) // the connection really was accepted and left silent
  })

  it('the bare request would never have finished: without the budget the pane has no answer', async () => {
    let settled = false
    const stuck = openAgainst(() => tlsOpen(port)).then((p) => { settled = true; return p })
    await new Promise(r => setTimeout(r, BUDGET_MS * 3))
    expect(settled).toBe(false)
    for (const c of cleanupSockets.splice(0)) c() // rejects the stuck request so the test can end
    expect((await stuck).loading).toBe(false)
  })

  it('ECONNREFUSED fails instantly with an error and no loading', async () => {
    const closed = await new Promise<number>(res => {
      const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)) })
    })
    const pane = await openAgainst(async () => {
      const outcome = await raceWithOpenBudget(() => tlsOpen(closed), BUDGET_MS)
      if (outcome.kind === 'timeout') throw new Error('unexpected timeout')
      return outcome.value
    })
    expect(pane.loading).toBe(false)
    expect(pane.error).toMatch(/ECONNREFUSED/)
  })

  it('ENETUNREACH fails instantly with an error and no loading', async () => {
    const pane = await openAgainst(() => Promise.reject(Object.assign(new Error('connect ENETUNREACH 192.0.2.1:993'), { code: 'ENETUNREACH' })))
    expect(pane).toEqual({ details: null, loading: false, error: 'connect ENETUNREACH 192.0.2.1:993' })
  })
})
