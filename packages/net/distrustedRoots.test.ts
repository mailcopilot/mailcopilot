import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import {
  __testOnly as distrustTestOnly,
  distrustedRootNames,
  isDistrustedRootPem,
  isDistrustedSpki,
  withoutDistrustedRoots,
} from './distrustedRoots'
import { __resetCombinedCaCacheForTest, buildTlsOptions, getBundledCaCertificates, getCombinedCaCertificates, isTlsTrustError } from './tls'

// Public certificate of "emSign Root TLS CA - G3", the direct issuer of the
// compromised intermediates (copied from the public incident tracker).
const EMSIGN_TLS_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICKTCCAa+gAwIBAgIQDnYGcvFDRZ/I/gqwvAXjlDAKBggqhkjOPQQDAzBWMQsw
CQYDVQQGEwJJTjElMCMGA1UECgwcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRl
ZDEgMB4GA1UEAwwXZW1TaWduIFJvb3QgVExTIENBIC0gRzMwHhcNMjQwMjA4MDgx
OTMyWhcNNDkwMjA3MDgxOTMyWjBWMQswCQYDVQQGEwJJTjElMCMGA1UECgwcZU11
ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAwwXZW1TaWduIFJvb3Qg
VExTIENBIC0gRzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARfD9w/q1cWxL6D9bMG
H6CQ4u+gAV6GN9s+PwQx9Bl4hC+0iU8QOk8mWO/RwXQy10DCSxT8vSIJClHKp+Ao
4qJKdYeV0SwZ7LMQziyLfxIUOY6Grja/sQFwLKYf8EdDXAyjQjBAMB0GA1UdDgQW
BBThOqshfPHjTVSu1HK3/YtZQiCQVDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAwNoADBlAjBhCFTkly7Yl7+s4hiw+k6ZJTXT2AiI
rvmsmfqPr5E7ecwXb6kXA5LTFd6rjwTuV3sCMQC9w6ZSbVq1mveMO6dKFziOzClT
KCT2RFT6yXtq6nzgRICgBmiXbJAXsmZ8yAwjyWc=
-----END CERTIFICATE-----
`

// Public certificates of the other two denylisted roots (from the same tracker).
const EMSIGN_ECC_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQG
EwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNo
bm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0g
RzMwHhcNMTgwMjE4MTgzMDAwWhcNNDMwMjE4MTgzMDAwWjBrMQswCQYDVQQGEwJJ
TjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9s
b2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMw
djAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3iAhKAnjlfSU2fySU0
WXTsuwYc58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4PPwT01xyS
fvalY8L1X44uT6EYGQIrMgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuB
zhccLikenEhjQjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggq
hkjOPQQDAwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+DCBeQyh+KTOgNG3qxrdWB
CUfvO6wIBHxcmbHtRwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7jHvrZQnD
+JbNR6iC8hZVdyR+EhCVBCyj
-----END CERTIFICATE-----
`
const AAA_CERTIFICATE_SERVICES = `-----BEGIN CERTIFICATE-----
MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQswCQYDVQQGEwJHQjEb
MBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYDVQQHDAdTYWxmb3JkMRow
GAYDVQQKDBFDb21vZG8gQ0EgTGltaXRlZDEhMB8GA1UEAwwYQUFBIENlcnRpZmlj
YXRlIFNlcnZpY2VzMB4XDTA0MDEwMTAwMDAwMFoXDTI4MTIzMTIzNTk1OVowezEL
MAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UE
BwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMM
GEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAL5AnfRu4ep2hxxNRUSOvkbIgwadwSr+GB+O5AL686tdUIoWMQua
BtDFcCLNSS1UY8y2bmhGC1Pqy0wkwLxyTurxFa70VJoSCsN6sjNg4tqJVfMiWPPe
3M/vg4aijJRPn2jymJBGhCfHdr/jzDUsi14HZGWCwEiwqJH5YZ92IFCokcdmtet4
YgNW8IoaE+oxox6gmf049vYnMlhvB/VruPsUK6+3qszWY19zjNoFmag4qMsXeDZR
rOme9Hg6jc8P2ULimAyrL58OAd7vn5lJ8S3frHRNG5i1R8XlKdH5kBjHYpy+g8cm
ez6KJcfA3Z3mNWgQIJ2P2N7Sw4ScDV7oL8kCAwEAAaOBwDCBvTAdBgNVHQ4EFgQU
oBEKIz6W8Qfs4q8p74Klf9AwpLQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF
MAMBAf8wewYDVR0fBHQwcjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v
QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNqA0oDKGMGh0dHA6Ly9jcmwuY29t
b2RvLm5ldC9BQUFDZXJ0aWZpY2F0ZVNlcnZpY2VzLmNybDANBgkqhkiG9w0BAQUF
AAOCAQEACFb8AvCb6P+k+tZ7xkSAzk/ExfYAWMymtrwUSWgEdujm7l3sAg9g1o1Q
GE8mTgHj5rCl7r+8dFRBv/38ErjHT1r0iWAFf2C3BUrz9vHCv8S5dIa2LX1rzNLz
Rt0vxuBqw8M0Ayx9lt1awg6nCpnBBYurDC/zXDrPbDdVCYfeU0BsWO/8tqtlbgT2
G9w84FoVxp7Z8VlIMCFlA2zs6SFz7JsDoeA3raAVGI/6ugLOpyypEBMs1OUIJqsi
l2D4kF501KKaU73yqWjgom7C12yxow+ev+to51byrvLjKzg6CYG1a4XXvi3tPxq3
smPi9WIsgtRqAEFQ8TmDn5XpNpaYbg==
-----END CERTIFICATE-----
`

// Self-signed P-256 test server (CN=localhost, SAN DNS:localhost + 127.0.0.1,
// valid until 2126). Stands in for "a root the platform hands us".
const LOCAL_CERT = `-----BEGIN CERTIFICATE-----
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
const LOCAL_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguOasucezz8VyHIG5
xJQLGwnCZ0gBCQcXiy4ir8Iou9WhRANCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJ
sjjIJj5H7OG1ImwnuIYUx1dXER1PMtuG36VxRW88HuMMyvs2Rz9fFY2t
-----END PRIVATE KEY-----
`

function spkiOf(pem: string): string {
  const der = new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(der).digest('hex')
}

/** Stub the three Node lists with the given system roots (default/bundled empty). */
function stubNodeStores(system: string[]): void {
  vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) =>
    type === 'system' ? system : []) as typeof tls.getCACertificates)
}

describe('packages/net/distrustedRoots', () => {
  beforeEach(() => __resetCombinedCaCacheForTest())
  afterEach(() => {
    vi.restoreAllMocks()
    __resetCombinedCaCacheForTest()
  })

  describe('denylist matching', () => {
    it('names the real compromised-chain root by its SPKI', () => {
      // The constant is copied from the incident disclosure; the fixture is the
      // certificate itself — the two must agree, or the filter matches nothing.
      expect(spkiOf(EMSIGN_TLS_ROOT_G3)).toBe(
        'c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9',
      )
      expect(isDistrustedSpki(spkiOf(EMSIGN_TLS_ROOT_G3))).toBe(true)
      expect(isDistrustedRootPem(EMSIGN_TLS_ROOT_G3)).toBe(true)
    })

    it('matches every denylisted root against a real certificate, so a typo cannot disable an entry', () => {
      const real: Array<[string, string]> = [
        ['emSign ECC Root CA - G3', EMSIGN_ECC_ROOT_G3],
        ['emSign Root TLS CA - G3', EMSIGN_TLS_ROOT_G3],
        ['AAA Certificate Services', AAA_CERTIFICATE_SERVICES],
      ]
      for (const [name, pem] of real) {
        expect(isDistrustedRootPem(pem), name).toBe(true)
        expect(new crypto.X509Certificate(pem).subject, name).toContain(name)
      }
      expect(real.length).toBe(distrustedRootNames().length)
    })

    it('keeps unrelated and unparsable entries (never narrows trust by accident)', () => {
      expect(isDistrustedRootPem(LOCAL_CERT)).toBe(false)
      expect(isDistrustedRootPem('not a certificate')).toBe(false)
      const list = [LOCAL_CERT, EMSIGN_TLS_ROOT_G3, 'garbage', LOCAL_CERT]
      expect(withoutDistrustedRoots(list)).toEqual([LOCAL_CERT, 'garbage', LOCAL_CERT])
    })

    it('covers every root the disclosure names', () => {
      expect(distrustedRootNames().sort()).toEqual([
        'AAA Certificate Services',
        'emSign ECC Root CA - G3',
        'emSign Root TLS CA - G3',
      ])
    })
  })

  describe('wiring into the CA lists', () => {
    it('drops the root from the combined list wherever it comes from', () => {
      stubNodeStores([EMSIGN_TLS_ROOT_G3, LOCAL_CERT])
      expect(getCombinedCaCertificates()).toEqual([LOCAL_CERT])
    })

    it('drops it from the bundled reference list too, so the interception probe agrees', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) =>
        type === 'bundled' ? [EMSIGN_TLS_ROOT_G3, LOCAL_CERT] : []) as typeof tls.getCACertificates)
      expect(getBundledCaCertificates()).toEqual([LOCAL_CERT])
    })
  })

  describe('against a real TLS handshake', () => {
    let server: tls.Server
    let port: number

    beforeEach(async () => {
      server = tls.createServer({ key: LOCAL_KEY, cert: LOCAL_CERT }, (s) => s.end())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    function handshake(options: tls.ConnectionOptions | undefined): Promise<{ ok: boolean; error?: Error }> {
      return new Promise((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, ...options }, () => {
          socket.end()
          resolve({ ok: true })
        })
        socket.on('error', (error) => resolve({ ok: false, error }))
      })
    }

    it('control: a platform-provided root that is not denylisted verifies', async () => {
      stubNodeStores([LOCAL_CERT])
      expect(await handshake(buildTlsOptions({ servername: 'localhost' }))).toEqual({ ok: true })
    })

    it('refuses a chain anchored at a denylisted root, and the error is a trust error', async () => {
      stubNodeStores([LOCAL_CERT])
      const restore = distrustTestOnly.addDistrusted(spkiOf(LOCAL_CERT))
      try {
        const result = await handshake(buildTlsOptions({ servername: 'localhost' }))
        expect(result.ok).toBe(false)
        expect(isTlsTrustError(result.error)).toBe(true)
      } finally {
        restore()
      }
    })

    it('a certificate the user pinned keeps working even if its key is denylisted', async () => {
      stubNodeStores([])
      const restore = distrustTestOnly.addDistrusted(spkiOf(LOCAL_CERT))
      try {
        const fingerprint = new crypto.X509Certificate(LOCAL_CERT).fingerprint256
        const options = buildTlsOptions({
          servername: 'localhost',
          tlsPinsSha256: [fingerprint],
          tlsPinnedCertsPem: [LOCAL_CERT],
        })
        expect(await handshake(options)).toEqual({ ok: true })
      } finally {
        restore()
      }
    })
  })
})
