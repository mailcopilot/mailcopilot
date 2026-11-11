// The open budget against a REAL stalled transport (§2.308): a local TCP server
// accepts the connection and then says nothing, which is what a degraded path
// looks like from the client (TCP connects, TLS never answers). The real
// `fetchMessageDetails` and the real ImapFlow talk to it; only the budget is
// scaled down, through the `timeoutMs` parameter of the production helper.
import { afterEach, describe, expect, it, vi } from 'vitest'
// message.ts reaches the SQLite layer (a native module built for Electron's ABI); nothing here touches it.
vi.mock('../../packages/db', () => ({}))

import crypto from 'node:crypto'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { fetchMessageDetails } from '../../packages/net/message'
import { IMAP_FETCH_TIMEOUT_MS, raceWithOpenBudget } from './openBudget'

const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUe7O1zl0EPagr9e5/e/nBT6w7j/gwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNDA4MjA1NloYDzIxMjYxMDEx
MDgyMDU2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJsjjIJj5H7OG1ImwnuIYUx1dX
ER1PMtuG36VxRW88HuMMyvs2Rz9fFY2to28wbTAdBgNVHQ4EFgQUzwpxW/YqbjSF
GathhZwqqEvBg6cwHwYDVR0jBBgwFoAUzwpxW/YqbjSFGathhZwqqEvBg6cwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgPidcNoRWPYbO85sta+REk1dI8I6O5inXsHQBFcBO+4sCIQC2
AIOppvCwlqEh+W0MCqGwtkBGiJ2r3fvP+odUx+Vzrg==
-----END CERTIFICATE-----
`
const trust = { tlsPinsSha256: [new crypto.X509Certificate(CERT).fingerprint256], tlsPinnedCertsPem: [CERT] }

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

/** Accepts TCP connections and stays silent forever: no ServerHello, no greeting. */
async function startSilentServer() {
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.on('error', () => {})
    sock.on('data', () => { /* the ClientHello is read and never answered */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { for (const s of sockets) s.destroy(); server.close() })
  return { port: (server.address() as AddressInfo).port, connections: () => sockets.length }
}

const BUDGET_MS = 300

describe('raceWithOpenBudget — the production open budget', () => {
  it('keeps the production value in one place', () => {
    expect(IMAP_FETCH_TIMEOUT_MS).toBe(10_000)
  })

  it('returns the result of a fetch that finishes in time', async () => {
    await expect(raceWithOpenBudget(async () => 'details', 50)).resolves.toEqual({ kind: 'ok', value: 'details' })
  })

  it('returns "timeout" and aborts the signal when the fetch outlives the budget; a late result or AbortError is swallowed', async () => {
    let seen: AbortSignal | undefined
    const outcome = await raceWithOpenBudget((signal) => {
      seen = signal
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }, 20)
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(seen!.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 20)) // no unhandled rejection from the late AbortError
  })

  it('lets an instant failure through (ECONNREFUSED / ENETUNREACH are not a timeout)', async () => {
    for (const code of ['ECONNREFUSED', 'ENETUNREACH']) {
      await expect(raceWithOpenBudget(() => Promise.reject(Object.assign(new Error(`connect ${code}`), { code })), 5_000))
        .rejects.toMatchObject({ code })
    }
  })
})

describe('the real fetch against a transport that connects and then goes silent', () => {
  const cfg = (port: number) => ({ host: '127.0.0.1', port, secure: true, user: 'u', pass: 'p', ...trust })

  it('is stuck on its own, yet the handler gets its answer within one budget', async () => {
    const srv = await startSilentServer()

    // Control: the bare fetch is genuinely stuck — this is why a budget is needed at all.
    let rawSettled = false
    const raw = fetchMessageDetails(1, cfg(srv.port), 'INBOX', 1)
    raw.then(() => { rawSettled = true }, () => { rawSettled = true })

    const started = Date.now()
    const outcome = await raceWithOpenBudget((signal) => fetchMessageDetails(1, cfg(srv.port), 'INBOX', 1, signal), BUDGET_MS)
    const elapsed = Date.now() - started

    expect(srv.connections()).toBeGreaterThan(0) // the TCP connection really was accepted
    expect(outcome).toEqual({ kind: 'timeout' }) // the handler maps this to the cached-headers fallback
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS - 50)
    expect(elapsed).toBeLessThan(BUDGET_MS * 5)
    expect(rawSettled).toBe(false)
  })
})
