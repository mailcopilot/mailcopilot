import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import tls from 'node:tls'
import type dns from 'node:dns'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  __testOnly,
  createPinnedLookup,
  isBlockedRemoteAddress,
  isBlockedRemoteHostname,
  requestSafeRemoteBytes,
  requestSafeRemoteStatus,
  type SafeAddressResolver,
} from './safeRemoteFetch'

// Long-lived self-signed fixture, byte-identical to the one in tls.test.ts
// (CN=localhost, SAN DNS:localhost + IP:127.0.0.1, valid until 2126).
// Embedded rather than generated per run so the suite needs neither the
// openssl binary nor seconds of RSA keygen, and cannot start failing on an
// expiry date. Used only to give the redirect-chain suite a real https hop.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUYng5+qY6Pz46P5ifBIu+lAFktvIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcyNDE4MTgzN1oYDzIxMjYw
NjMwMTgxODM3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDF3DgKj1p4qNx9UWyatjUgvIGU93QAbuAq4c1a9UqM
Dj4TdkIhTNAn2TuD9J07KZkUPFlU5M0vOljU+Z/Agsk35FnNs6CKvQ9sKNUnFcEt
XwcRkZhzMeKRxSx5qQ8PoOxDiZwS6etyU9/9STOx8yiURpNlJ5SXWzp5Bl/7KcXt
INfjERMr28Uc51/plidqsfS1/4AMtk6ir9DvmZpl2WZPz0z4xwqOLBFzEb790URo
ENcCJ7QXQk5JV88Bl4Z5Rqs91hUln2lpZpwdhpIfDgaOTfo5NOTsxs3kTiG0QKbf
hCk26ow95V5n0ftSLQUl16WyfVTQxsI7LRqyHNAuoZKjAgMBAAGjbzBtMB0GA1Ud
DgQWBBSMTxdZnzw8MvXge35dWww4KdH4nDAfBgNVHSMEGDAWgBSMTxdZnzw8MvXg
e35dWww4KdH4nDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAryaBVnesyINfE6tpzrAZCyf2z6c9
h8vK1yrDxZ44KaMUzANWouAIEjtJy39da8RvoFZdLL67CAlFmXMedc0cHUijspgh
vuL8qmUsrzYNAeg5gQpsbTsFfMgvJhAYHHimOwDj0KbikjVb+PZrWVAUZn6fHu1S
UP6vvf7JoDZz0a99xeUa3S3nzL0JT6b9+vXoL0AoV7vTfUA02zO5gaH1+r62QYbj
z8X97d/SjBh4NEJfO+hrky9+uj4/H1EKdjSxzScjmT5QMHenlq1Xboek5IRSiTkm
u2Ka43+yHsBbQMfubE4Ku4jiDZeMmJQEWFQEYErb1LrG09pC5nAbYnl/rg==
-----END CERTIFICATE-----
`

const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDF3DgKj1p4qNx9
UWyatjUgvIGU93QAbuAq4c1a9UqMDj4TdkIhTNAn2TuD9J07KZkUPFlU5M0vOljU
+Z/Agsk35FnNs6CKvQ9sKNUnFcEtXwcRkZhzMeKRxSx5qQ8PoOxDiZwS6etyU9/9
STOx8yiURpNlJ5SXWzp5Bl/7KcXtINfjERMr28Uc51/plidqsfS1/4AMtk6ir9Dv
mZpl2WZPz0z4xwqOLBFzEb790URoENcCJ7QXQk5JV88Bl4Z5Rqs91hUln2lpZpwd
hpIfDgaOTfo5NOTsxs3kTiG0QKbfhCk26ow95V5n0ftSLQUl16WyfVTQxsI7LRqy
HNAuoZKjAgMBAAECggEAC34YcznoaLcbjNvnPFqhCLRqV8YXzX6jNAUcRyWVnZT7
iL3cZtAYtyJ9u9MViZOHpLlB/GsIeq8flx9OEYHcljaD+4LCLHeBfH19WWErcKs4
XzjfFgcrwIknZYRVr561RSb/vcmAjN96VIf6ogzG//XUJz1T+tv9sCdCo/Vv3a9p
tEouUjbWOOqGFUR9X2Aq05DGTrNQMNWZGSIXMDJeeF51ZC69p8w/BS5u+B3NWTdx
wDbuq5/ivkdFbdKYaF4g7DXksmr6nxE6/70ls68R24/tIuBnWuB/g183ye61lY+w
00LX9jd26sVnPdebbs6Slu4dcek/H1TU80ohdvJhAQKBgQD8X48Mq26Egc8oVTNs
Pej1Hf6d1gN54CdrKxxJ1BlMD/KmHK1aa+gOz+Xz8oDTcqFgtsPFZppZrx9rZs1e
+gWDOGF5XyJ5jGTWWlPx0UJfAmSo4gwKiWfGbGRr1zEneq42kO6124f/PYHNcMF3
x7iOeFO5TnG1y4/1i9TUPSlQwwKBgQDItB2DHNF4kydZOAji6BYNx3bZdink49u/
bjHLFI9S0x9s2MYVjl28EBvSfpMOHyrBukNHYNwSftNxhOjCmfvvpIPhbQWcEO8p
fzhbkBjvA39IuSbo33sGIdP6SrwjvFragjqRLfKuXtYvoo0XeOMCabp8CL3jxyHV
bVwE1maYoQKBgFAtt8/Joxn796mTr/uii6FcPyk79ezBdySIFLur48GTi36Uu8pv
X9Fc4WyoTZ9f2r9UMUxEtaLqjSvdBEA5ZIj035rky5ocLWkgV20LE3AF3Z79+d9b
GhojE6BjRJ2LT0/Mqdoi/cjsbJGtUfnQ/ORefBLyRhQAsSLMovgu2jJrAoGAIfZo
sBEmWTL9i5lx14PSh45jTDU0rajpPKGXB3h5MFjNjou4KVmn/vTy4FHO7KrVf2bX
j7KSSwbvHNySzqtj+I9sSa87Lcen0OvYS5Y8weVjmpjKPsnidY0v48DVyW5MKYG0
C3EtCdi+gd0N5xTrxTLC/c404+CElyskUSU+w0ECgYEA60LNY+vXKCWtiN9qXVXw
4EDTmkPg0H2aDy2Re2mnfQD4o2JNjpWCwq8IQOSsMThV8txsgbggCfOJIy6cQA/D
Sa14BqPVPhCVkpSW7H79Od3aanjvCegr+plZJq3/QX9bIYYgIVJ7OstPDD07jbIt
hkvgyFLB4X4z08gl6re3vDw=
-----END PRIVATE KEY-----
`

/** Probes whether this machine can actually bind IPv6 loopback. */
function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '::1', () => probe.close(() => resolve(true)))
  })
}

describe('packages/net/safeRemoteFetch', () => {
  describe('isBlockedRemoteHostname', () => {
    it('blocks localhost and internal suffixes', () => {
      expect(isBlockedRemoteHostname('localhost')).toBe(true)
      expect(isBlockedRemoteHostname('db.internal')).toBe(true)
      expect(isBlockedRemoteHostname('printer.local')).toBe(true)
      expect(isBlockedRemoteHostname('router.home.arpa')).toBe(true)
    })

    it('allows regular public hostnames', () => {
      expect(isBlockedRemoteHostname('example.com')).toBe(false)
      expect(isBlockedRemoteHostname('internal.example.com')).toBe(false)
    })

    it('blocks sub-domains of localhost', () => {
      expect(isBlockedRemoteHostname('app.localhost')).toBe(true)
    })

    it('handles trailing dots in hostnames', () => {
      expect(isBlockedRemoteHostname('localhost.')).toBe(true)
      expect(isBlockedRemoteHostname('example.com.')).toBe(false)
    })
  })

  describe('isBlockedRemoteAddress', () => {
    it('blocks local and private IPv4 ranges', () => {
      expect(isBlockedRemoteAddress('127.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('127.255.255.255')).toBe(true)
      expect(isBlockedRemoteAddress('10.0.0.5')).toBe(true)
      expect(isBlockedRemoteAddress('100.64.10.20')).toBe(true)
      expect(isBlockedRemoteAddress('169.254.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('172.20.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('192.168.1.10')).toBe(true)
      expect(isBlockedRemoteAddress('198.18.0.10')).toBe(true)
      expect(isBlockedRemoteAddress('0.0.0.0')).toBe(true)
    })

    it('blocks multicast and reserved IPv4 ranges', () => {
      expect(isBlockedRemoteAddress('224.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('255.255.255.255')).toBe(true)
    })

    it('blocks local and private IPv6 ranges', () => {
      expect(isBlockedRemoteAddress('::')).toBe(true)
      expect(isBlockedRemoteAddress('::1')).toBe(true)
      expect(isBlockedRemoteAddress('fe80::1')).toBe(true)
      expect(isBlockedRemoteAddress('fd00::1')).toBe(true)
      expect(isBlockedRemoteAddress('ff02::1')).toBe(true)
    })

    // Site-local fec0::/10 is deprecated (RFC 3879) but still routed on kit
    // that predates the deprecation, and it is not link-local: the link-local
    // test matches `fe80::/10` by the top two bits of the second byte, so
    // `fec0::1` answered `false` and stayed reachable from an email.
    it('blocks the deprecated site-local fec0::/10 range', () => {
      expect(isBlockedRemoteAddress('fec0::1')).toBe(true)
      expect(isBlockedRemoteAddress('feff:ffff::1')).toBe(true)
      // The neighbouring halves of fe00::/8 keep their own verdicts: fe80::/10
      // is link-local (blocked above) and fe00::/9 below it is not ours to
      // block wholesale.
      expect(isBlockedRemoteAddress('fe00::1')).toBe(false)
    })

    it('blocks IPv4-mapped IPv6 private addresses', () => {
      expect(isBlockedRemoteAddress('::ffff:127.0.0.1')).toBe(true)
      expect(isBlockedRemoteAddress('::ffff:192.168.1.1')).toBe(true)
      expect(isBlockedRemoteAddress('::ffff:10.0.0.1')).toBe(true)
    })

    it('allows IPv4-mapped IPv6 public addresses', () => {
      expect(isBlockedRemoteAddress('::ffff:8.8.8.8')).toBe(false)
    })

    // Regression: the block list recursed into the embedded IPv4 address only
    // for the IPv4-*mapped* form, so every other way of spelling a loopback or
    // RFC 1918 host in IPv6 walked straight through. `http://[::127.0.0.1]/`
    // out of an email reached the loopback interface.
    it('blocks IPv6 forms that embed a blocked IPv4 address', () => {
      expect(isBlockedRemoteAddress('::127.0.0.1')).toBe(true)      // IPv4-compatible (deprecated)
      expect(isBlockedRemoteAddress('::ffff:0:7f00:1')).toBe(true)  // IPv4-translated ::ffff:0:0/96
      expect(isBlockedRemoteAddress('::ffff:0:c0a8:1')).toBe(true)  // IPv4-translated 192.168.0.1
      expect(isBlockedRemoteAddress('64:ff9b::7f00:1')).toBe(true)  // NAT64 -> 127.0.0.1
      expect(isBlockedRemoteAddress('64:ff9b::a9fe:a9fe')).toBe(true) // NAT64 -> 169.254.169.254
      expect(isBlockedRemoteAddress('2002:7f00:1::')).toBe(true)    // 6to4 -> 127.0.0.1
      expect(isBlockedRemoteAddress('2002:a9fe:a9fe::1')).toBe(true) // 6to4 -> 169.254.169.254
      expect(isBlockedRemoteAddress('2002:c0a8:101::')).toBe(true)  // 6to4 -> 192.168.1.1
    })

    // `::/8` is IANA-reserved end to end, so it is blocked as a range rather
    // than address by address.
    it('blocks the whole reserved ::/8 range', () => {
      expect(isBlockedRemoteAddress('::2')).toBe(true)
      expect(isBlockedRemoteAddress('0:1234::1')).toBe(true)
    })

    // The block on embedded-IPv4 prefixes is a recursion into the IPv4 list,
    // not a blanket ban: NAT64 and 6to4 addresses naming a public IPv4 host
    // stay reachable, exactly like the IPv4-mapped form above.
    it('allows NAT64 and 6to4 addresses that embed a public IPv4 address', () => {
      expect(isBlockedRemoteAddress('64:ff9b::8.8.8.8')).toBe(false)
      expect(isBlockedRemoteAddress('64:ff9b::808:808')).toBe(false)
      expect(isBlockedRemoteAddress('2002:808:808::')).toBe(false)
      expect(isBlockedRemoteAddress('2002:101:101::1')).toBe(false)
    })

    it('allows public IPv4 and IPv6 addresses', () => {
      expect(isBlockedRemoteAddress('8.8.8.8')).toBe(false)
      expect(isBlockedRemoteAddress('1.1.1.1')).toBe(false)
      expect(isBlockedRemoteAddress('2001:4860:4860::8888')).toBe(false)
    })

    it('blocks invalid addresses', () => {
      expect(isBlockedRemoteAddress('not-an-ip')).toBe(true)
    })
  })

  // §3.10 P0 regression — the HTML email external-image proxy (main-process
  // `net:fetchExternalImage`) relies on requestSafeRemoteBytes -> resolveSafeAddress
  // to block SSRF-class targets that would otherwise be reachable from the
  // main process. These are the exact targets called out in the acceptance
  // criteria for the P0 HTML email hardening task. If any of these starts
  // returning `false`, the renderer iframe hardening is one short-circuit
  // away from letting a crafted email probe loopback/RFC1918 hosts.
  describe('§3.10 P0 HTML email SSRF block surface', () => {
    const SSRF_BLOCKED_ADDRESSES = [
      // IPv4 loopback / RFC1918 / link-local / multicast — the set named in
      // BACKLOG §3.10 P0 "HTML email external resource hardening".
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254', // cloud-metadata endpoint — classic SSRF pivot
      '224.0.0.1',       // multicast
      // IPv6 equivalents.
      '::1',             // loopback
      'fe80::1',         // link-local
      'ff02::1',         // multicast
    ]

    for (const addr of SSRF_BLOCKED_ADDRESSES) {
      it(`blocks SSRF target ${addr}`, () => {
        expect(isBlockedRemoteAddress(addr)).toBe(true)
      })
    }

    it('blocks localhost by hostname literal', () => {
      expect(isBlockedRemoteHostname('localhost')).toBe(true)
    })
  })

  // Regression: every request through safeRemoteFetch died with
  // ERR_INVALID_IP_ADDRESS before a socket was opened, because the pinned
  // `lookup` callback only spoke the legacy `(err, address, family)` shape
  // while Node >= 20 asks for `{ all: true }` and iterates the answer as an
  // array. Both shapes must keep working, and the pin must stay a single
  // pre-vetted address.
  describe('createPinnedLookup', () => {
    it('answers with an address array when the socket asks for all', () => {
      const lookup = createPinnedLookup({ address: '203.0.113.7', family: 4 })
      let seen: Parameters<Parameters<typeof lookup>[2]> | undefined
      lookup('example.com', { all: true, hints: 32 }, (...args) => { seen = args })

      expect(seen?.[0]).toBeNull()
      expect(seen?.[1]).toEqual([{ address: '203.0.113.7', family: 4 }])
    })

    it('answers with the legacy triple when the socket asks for one address', () => {
      const lookup = createPinnedLookup({ address: '2001:db8::1', family: 6 })
      let seen: Parameters<Parameters<typeof lookup>[2]> | undefined
      lookup('example.com', {}, (...args) => { seen = args })

      expect(seen?.[0]).toBeNull()
      expect(seen?.[1]).toBe('2001:db8::1')
      expect(seen?.[2]).toBe(6)
    })

    it('pins to exactly one address in both shapes', () => {
      const lookup = createPinnedLookup({ address: '203.0.113.7', family: 4 })
      let all: string | dns.LookupAddress[] | undefined
      lookup('example.com', { all: true }, (_err, address) => { all = address })
      expect(Array.isArray(all) ? all.length : -1).toBe(1)
    })
  })

  // Contract test against the real Node socket layer rather than against our
  // idea of it: this is the path that actually regressed. It never touches
  // resolveSafeAddress, so the private-range block list does not apply — the
  // point is only that a pinned lookup can still open a connection.
  describe('createPinnedLookup against a real socket', () => {
    let server: http.Server
    let port = 0
    // Probed rather than assumed: on a runner with IPv6 disabled the ::1 leg
    // cannot bind at all. A permanently red test inside a security boundary
    // file invites someone to weaken the boundary instead of fixing the
    // environment, so that leg skips itself instead.
    let hasIpv6 = false

    beforeAll(async () => {
      hasIpv6 = await ipv6LoopbackAvailable()
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('pinned')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })

    afterAll(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it('connects to the pinned address without re-resolving the hostname', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: 'example.invalid',
          port,
          path: '/',
          method: 'GET',
          lookup: createPinnedLookup({ address: '127.0.0.1', family: 4 }),
        }, res => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end()
      })

      expect(status).toBe(200)
    })

    it('connects over IPv6 when the pin carries family 6', async ctx => {
      if (!hasIpv6) ctx.skip()
      const v6Server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('pinned-v6')
      })
      await new Promise<void>((resolve, reject) => {
        v6Server.listen(0, '::1', resolve)
        v6Server.on('error', reject)
      })
      const v6Port = (v6Server.address() as AddressInfo).port

      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request({
            hostname: 'example.invalid',
            port: v6Port,
            path: '/',
            method: 'GET',
            lookup: createPinnedLookup({ address: '::1', family: 6 }),
          }, res => {
            res.resume()
            resolve(res.statusCode ?? 0)
          })
          req.on('error', reject)
          req.end()
        })

        expect(status).toBe(200)
      } finally {
        await new Promise<void>(resolve => v6Server.close(() => resolve()))
      }
    })
  })

  // Regression guard: the fix touched only how the pinned address is handed
  // to the socket layer. It must not have loosened (or reordered relative
  // to) the SSRF block list that resolveSafeAddress consults before any
  // lookup callback is even built — these entry points are exactly what
  // net:fetchExternalImage (requestSafeRemoteBytes) and one-click unsubscribe
  // (requestSafeRemoteStatus) call with attacker-influenced URLs. If the
  // block check were dropped or moved after socket creation, these calls
  // would attempt a real connection (timeout/ECONNREFUSED) instead of
  // rejecting synchronously with 'blocked host'.
  describe('SSRF guard survives the lookup fix', () => {
    it('requestSafeRemoteStatus rejects a blocked loopback IPv4 literal', async () => {
      await expect(
        requestSafeRemoteStatus('http://127.0.0.1:9/', { timeoutMs: 500 }),
      ).rejects.toThrow('blocked host')
    })

    it('requestSafeRemoteStatus rejects a blocked loopback IPv6 literal', async () => {
      await expect(
        requestSafeRemoteStatus('http://[::1]:9/', { timeoutMs: 500 }),
      ).rejects.toThrow('blocked host')
    })

    it('requestSafeRemoteStatus rejects a blocked hostname suffix without a DNS lookup', async () => {
      await expect(
        requestSafeRemoteStatus('http://printer.local/', { timeoutMs: 500 }),
      ).rejects.toThrow('blocked host')
    })

    it('requestSafeRemoteBytes rejects a blocked private IPv4 literal', async () => {
      await expect(
        requestSafeRemoteBytes('http://192.168.1.1:9/', 1024, { timeoutMs: 500 }),
      ).rejects.toThrow('blocked host')
    })
  })

  // ---------------------------------------------------------------------
  // Redirect-chain coverage. Until the pinned-lookup fix, not one request
  // survived far enough to reach this loop, so none of it — scheme rule,
  // per-hop re-vetting, redirect cap, size caps — had ever run against
  // attacker-influenced input.
  //
  // Everything below drives the real loop through the documented test seam
  // `__testOnly`: a resolver stub that pins every hostname to 127.0.0.1. The
  // seam exists because the loop is otherwise unreachable from a test — every
  // address a local server can bind is one the block list rightly refuses, and
  // loosening the block list to make a test possible is not an option. It is
  // NOT a trailing parameter of the public functions: there, one extra
  // argument at a call site would switch the block list off. The block list
  // itself keeps its own coverage through the public entry points above,
  // which reject with 'blocked host'.
  //
  // The https leg is a real TLS handshake against the long-lived self-signed
  // fixture. Trust is granted by ADDING that certificate to the global
  // agent's CA list for the duration of this suite (restored afterwards):
  // additive in the literal sense — whatever the agent already trusted stays
  // trusted — verification stays fully on, nothing sets
  // rejectUnauthorized: false.
  // ---------------------------------------------------------------------
  describe('redirect chain', () => {
    type Hit = { path: string, method: string, body: string }
    type Routes = Record<string, (res: http.ServerResponse) => void>

    let httpServer: http.Server
    let httpsServer: https.Server
    let httpBase = ''
    let httpsBase = ''
    let httpRoutes: Routes = {}
    let httpsRoutes: Routes = {}
    let previousCa: https.AgentOptions['ca']
    const httpHits: Hit[] = []
    const httpsHits: Hit[] = []
    const resolvedHosts: string[] = []

    const pinToLoopback: SafeAddressResolver = async hostname => {
      resolvedHosts.push(hostname)
      return { address: '127.0.0.1', family: 4 }
    }

    function handler(hits: Hit[], routes: () => Routes): http.RequestListener {
      return (req, res) => {
        // The client destroys sockets on purpose in several tests; a write
        // that loses the race must not become an unhandled 'error'.
        res.on('error', () => {})
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          const path = req.url ?? '/'
          hits.push({ path, method: req.method ?? '', body: Buffer.concat(chunks).toString('utf8') })
          const route = routes()[path]
          if (!route) {
            res.writeHead(404)
            res.end()
            return
          }
          route(res)
        })
      }
    }

    beforeAll(async () => {
      previousCa = https.globalAgent.options.ca
      // Additive, and literally so: the agent keeps whatever it already
      // trusted and gains the fixture on top. A bare `[FIXTURE_CERT]` would
      // have been a REPLACEMENT narrowing the agent to one root — safe in
      // direction, but then the word "additive" here and in ARCHITECTURE.md
      // would be a comment promising something the code does not do.
      //
      // When the agent carries no list at all, the base is the BUNDLED
      // Mozilla set (`tls.rootCertificates`), which is not the same thing as
      // Node's effective default: that also includes `NODE_EXTRA_CA_CERTS`
      // (see packages/net/tls.ts, where the distinction is load-bearing). So
      // on a machine that sets it, this suite narrows trust for its own
      // duration. Narrowing is the safe direction and the scope is one
      // vitest worker, but do not read this line as "the real root store".
      const previousCaList = previousCa === undefined
        ? tls.rootCertificates
        : (Array.isArray(previousCa) ? previousCa : [previousCa])
      https.globalAgent.options.ca = [...previousCaList, FIXTURE_CERT]

      httpServer = http.createServer(handler(httpHits, () => httpRoutes))
      await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
      httpBase = `http://localhost:${(httpServer.address() as AddressInfo).port}`

      httpsServer = https.createServer(
        { key: FIXTURE_KEY, cert: FIXTURE_CERT },
        handler(httpsHits, () => httpsRoutes),
      )
      await new Promise<void>(resolve => httpsServer.listen(0, '127.0.0.1', resolve))
      httpsBase = `https://localhost:${(httpsServer.address() as AddressInfo).port}`
    })

    afterAll(async () => {
      https.globalAgent.options.ca = previousCa
      httpServer.closeAllConnections()
      httpsServer.closeAllConnections()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
      await new Promise<void>(resolve => httpsServer.close(() => resolve()))
    })

    beforeEach(() => {
      httpRoutes = {}
      httpsRoutes = {}
      httpHits.length = 0
      httpsHits.length = 0
      resolvedHosts.length = 0
    })

    it('follows a chain that stays on http and re-vets every hop', async () => {
      httpRoutes = {
        '/a': res => { res.writeHead(302, { location: '/b' }); res.end() },
        '/b': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('done') },
      }

      const response = await __testOnly.requestSafeRemoteBytes(`${httpBase}/a`, 1024, { timeoutMs: 2000 }, pinToLoopback)

      expect(response.status).toBe(200)
      expect(response.body.toString('utf8')).toBe('done')
      expect(response.url).toBe(`${httpBase}/b`)
      expect(httpHits.map(hit => hit.path)).toEqual(['/a', '/b'])
      // Every hop is re-vetted; the first answer is never reused.
      expect(resolvedHosts).toEqual(['localhost', 'localhost'])
    })

    it('allows an upgrade from http to https', async () => {
      httpRoutes = { '/up': res => { res.writeHead(302, { location: `${httpsBase}/landing` }); res.end() } }
      httpsRoutes = { '/landing': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('secure') } }

      const response = await __testOnly.requestSafeRemoteBytes(`${httpBase}/up`, 1024, { timeoutMs: 2000 }, pinToLoopback)

      expect(response.status).toBe(200)
      expect(response.url).toBe(`${httpsBase}/landing`)
      expect(httpsHits.map(hit => hit.path)).toEqual(['/landing'])
    })

    // HIGH: the chain used to accept any http/https hop, so a sender's server
    // could answer a 302 with a cleartext Location and silently undo the
    // https-only promise that unsubscribe.ts checks once, at the entry.
    it('refuses to step back from https to http', async () => {
      httpsRoutes = { '/down': res => { res.writeHead(302, { location: `${httpBase}/landing` }); res.end() } }
      httpRoutes = { '/landing': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('cleartext') } }

      await expect(
        __testOnly.requestSafeRemoteStatus(`${httpsBase}/down`, { timeoutMs: 2000 }, pinToLoopback),
      ).rejects.toThrow('blocked downgrade')

      expect(httpHits).toEqual([])
    })

    // The same hop as a 307, which keeps method and body: without the scheme
    // rule the one-click POST — recipient token in the URL, opt-out body —
    // would be replayed over cleartext.
    it('refuses the downgrade before a 307 can replay the POST body in the clear', async () => {
      httpsRoutes = { '/one-click': res => { res.writeHead(307, { location: `${httpBase}/landing` }); res.end() } }
      httpRoutes = { '/landing': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') } }

      await expect(
        __testOnly.requestSafeRemoteStatus(`${httpsBase}/one-click`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          timeoutMs: 2000,
        }, pinToLoopback),
      ).rejects.toThrow('blocked downgrade')

      expect(httpsHits).toEqual([
        { path: '/one-click', method: 'POST', body: 'List-Unsubscribe=One-Click' },
      ])
      expect(httpHits).toEqual([])
    })

    // The case that separates "have we ever seen https" from "what was the
    // initial scheme". A rule phrased against the initial scheme waves this
    // chain through: it starts on http, so nothing looks like a downgrade —
    // yet by the third hop the request that already travelled inside TLS is
    // back on the wire in the clear. The direct https -> http test above
    // passes under either phrasing, so it cannot pin this property; only this
    // one can.
    it('refuses to step back to http after the chain has been on https', async () => {
      httpRoutes = {
        '/start': res => { res.writeHead(302, { location: `${httpsBase}/mid` }); res.end() },
        '/end': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('cleartext') },
      }
      httpsRoutes = { '/mid': res => { res.writeHead(302, { location: `${httpBase}/end` }); res.end() } }

      await expect(
        __testOnly.requestSafeRemoteStatus(`${httpBase}/start`, { timeoutMs: 2000 }, pinToLoopback),
      ).rejects.toThrow('blocked downgrade')

      // The https hop happened; the cleartext hop after it never did.
      expect(httpsHits.map(hit => hit.path)).toEqual(['/mid'])
      expect(httpHits.map(hit => hit.path)).toEqual(['/start'])
    })

    it('keeps method and body across a 308 when the scheme does not change', async () => {
      httpRoutes = {
        '/keep': res => { res.writeHead(308, { location: '/echo' }); res.end() },
        '/echo': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') },
      }

      await __testOnly.requestSafeRemoteStatus(`${httpBase}/keep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        timeoutMs: 2000,
      }, pinToLoopback)

      expect(httpHits).toEqual([
        { path: '/keep', method: 'POST', body: 'List-Unsubscribe=One-Click' },
        { path: '/echo', method: 'POST', body: 'List-Unsubscribe=One-Click' },
      ])
    })

    it('turns a 303 into a bodyless GET', async () => {
      httpRoutes = {
        '/see-other': res => { res.writeHead(303, { location: '/echo' }); res.end() },
        '/echo': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') },
      }

      await __testOnly.requestSafeRemoteStatus(`${httpBase}/see-other`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        timeoutMs: 2000,
      }, pinToLoopback)

      expect(httpHits[1]).toEqual({ path: '/echo', method: 'GET', body: '' })
    })

    it('stops at maxRedirects instead of following a loop', async () => {
      httpRoutes = { '/loop': res => { res.writeHead(302, { location: '/loop' }); res.end() } }

      await expect(
        __testOnly.requestSafeRemoteStatus(`${httpBase}/loop`, { timeoutMs: 2000, maxRedirects: 2 }, pinToLoopback),
      ).rejects.toThrow('too many redirects')

      expect(httpHits).toHaveLength(3)
    })

    // The other side of the same boundary: the cap must reject the hop AFTER
    // the last allowed one, not the last allowed one itself. With
    // maxRedirects: 2 a chain of exactly two redirects has to end in a served
    // response — the classic off-by-one here would turn a legitimate
    // two-redirect unsubscribe link into 'too many redirects'.
    it('serves the response after exactly maxRedirects hops', async () => {
      httpRoutes = {
        '/r1': res => { res.writeHead(302, { location: '/r2' }); res.end() },
        '/r2': res => { res.writeHead(302, { location: '/r3' }); res.end() },
        '/r3': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived') },
      }

      const response = await __testOnly.requestSafeRemoteBytes(
        `${httpBase}/r1`,
        1024,
        { timeoutMs: 2000, maxRedirects: 2 },
        pinToLoopback,
      )

      expect(response.status).toBe(200)
      expect(response.body.toString('utf8')).toBe('arrived')
      expect(response.url).toBe(`${httpBase}/r3`)
      expect(httpHits.map(hit => hit.path)).toEqual(['/r1', '/r2', '/r3'])
    })

    it('rejects a redirect without a Location header', async () => {
      httpRoutes = { '/nowhere': res => { res.writeHead(302); res.end() } }

      await expect(
        __testOnly.requestSafeRemoteStatus(`${httpBase}/nowhere`, { timeoutMs: 2000 }, pinToLoopback),
      ).rejects.toThrow('redirect without location')
    })

    // The declared length is over the cap while the actual body is four bytes,
    // far under it — only the header pre-check can produce this rejection.
    it('rejects on the declared content-length before reading a body', async () => {
      httpRoutes = { '/fat': res => { res.writeHead(200, { 'content-length': '5000' }); res.end('tiny') } }

      await expect(
        __testOnly.requestSafeRemoteBytes(`${httpBase}/fat`, 1024, { timeoutMs: 2000 }, pinToLoopback),
      ).rejects.toThrow('response too large')
    })

    // Mirror image: no content-length to pre-check, so the cap has to be
    // enforced while the body streams in.
    //
    // The route deliberately never ends the response. That is what makes the
    // test deterministic about the reject/destroy order: an IncomingMessage
    // that is still incomplete emits 'aborted' SYNCHRONOUSLY from
    // `destroy()`, so if the reader destroyed the stream before rejecting,
    // the 'aborted' listener would win and this would surface as 'response
    // aborted' — a transport failure — instead of our own size cap. With a
    // completed body the emit does not happen at all and the assertion would
    // hold under either order, i.e. it would not be about the race.
    it('stops a chunked body that outgrows the cap and reports the cap, not an abort', async () => {
      const openResponses: http.ServerResponse[] = []
      httpRoutes = {
        '/stream': res => {
          openResponses.push(res)
          res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
          res.write('x'.repeat(2048))
          // No res.end(): the message stays incomplete on the client side.
        },
      }

      try {
        await expect(
          __testOnly.requestSafeRemoteBytes(`${httpBase}/stream`, 1024, { timeoutMs: 2000 }, pinToLoopback),
        ).rejects.toThrow(/^response too large$/)
      } finally {
        for (const res of openResponses) res.destroy()
      }
    })

    it('returns a body that fits under the cap', async () => {
      httpRoutes = {
        '/small': res => {
          res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
          res.end('x'.repeat(512))
        },
      }

      const response = await __testOnly.requestSafeRemoteBytes(`${httpBase}/small`, 1024, { timeoutMs: 2000 }, pinToLoopback)
      expect(response.body).toHaveLength(512)
    })
  })
})
