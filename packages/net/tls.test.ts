import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import {
  buildTlsOptions,
  getBundledCaCertificates,
  getCombinedCaCertificates,
  isTlsTrustError,
  normalizeFingerprintSha256,
  unknownCertTrust,
  verifyCertTrust,
  CA_CACHE_TTL_MS,
  __resetCombinedCaCacheForTest,
} from './tls'

// ---------------------------------------------------------------------------
// Long-lived self-signed fixture (CN=localhost, SAN DNS:localhost + IP
// 127.0.0.1, valid until 2126). Embedded rather than generated per run so the
// suite needs neither the openssl binary nor seconds of RSA keygen.
// ---------------------------------------------------------------------------
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
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

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
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

const SELF_SIGNED_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(SELF_SIGNED_CERT).fingerprint256,
)

// ---------------------------------------------------------------------------
// Second fixture — SAN carries DNS:mail.example.test and NOTHING else (no IP
// entry, valid until 2126). This is the shape of the real-world regression:
// an account configured with a bare IP host whose server certificate names
// only domains, so Node's identity check fails with
// ERR_TLS_CERT_ALTNAME_INVALID ("IP: … is not in the cert's list") while the
// certificate itself is exactly the one the user confirmed and pinned.
// The primary fixture above cannot express this — its SAN includes
// IP:127.0.0.1, so a connection dialled by IP passes the name check.
// ---------------------------------------------------------------------------
const DNS_ONLY_CERT = `-----BEGIN CERTIFICATE-----
MIIDOTCCAiGgAwIBAgIUb3yD4WXYPmRx48kl5Ax9XZkP2VQwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRbWFpbC5leGFtcGxlLnRlc3QwIBcNMjYwNzI2MTkyODU2
WhgPMjEyNjA3MDIxOTI4NTZaMBwxGjAYBgNVBAMMEW1haWwuZXhhbXBsZS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt5vdFk6wZP/ti3kj/1MR
hL/82EqsfTYKuBVTuEBp6giSMYEpRHnl+aVLYpHedncCK/5hdP1p8YT4DC4VEXmi
bXlGsKwd66XhaEzGO/YVNJ/fVo8AW+QwmX3rKu63/AInmzGqbFz49afxcI058dXw
N0V3yg5GTwVhvfWU7Bd873XvDlLZlfdo7hLzXhzHbqUzfaqBgAKaWGd6Cj3y8nh2
d5gpVk1sx8drhNkJ7wJGvmDhaVt9DwXXyBx10dQ4lbPJCKhFo+eaY6fwryt7Qk5J
q67o9eAr7BuvVWX3x9zV6PwGyyUogTatlt5FGd+EOI2ch/scqOjJWdkicgn0zuTG
2wIDAQABo3EwbzAdBgNVHQ4EFgQUSX+dwu1aIcFI8M2Gp8PVoTkO9kcwHwYDVR0j
BBgwFoAUSX+dwu1aIcFI8M2Gp8PVoTkO9kcwDwYDVR0TAQH/BAUwAwEB/zAcBgNV
HREEFTATghFtYWlsLmV4YW1wbGUudGVzdDANBgkqhkiG9w0BAQsFAAOCAQEAs9l2
+ZnCIClgwm+vkVud9fc9apcvzF/9hJWC6xszyq/7MxqDoEUdlgCJGzuvLk/9yrfj
kMO+d7akLS9UjCCsSCtP3/xbx2aMJPvTUHBjBhH/GQ7xAucDxIKSUJ9UKqr70Jj/
oCJDKxnF1ir6uH3fXEPy4e4kiMkw+q3CikOFxwk4HHNUVNWtmzekHFbeweWs9XD6
42dLCUjb7mC7am0XSuE1iH/eTxRYHbTmYA9UkTi0GVrM+d856WTq3eoXrwGIiAe/
VaTTlpoguDDLHgSMKHNLEnU2Tg+lWKe6DYqqVoh8zKjcFA//GtBLqhj0tZV3V+/L
a+3kDWSBLZw9wshv+A==
-----END CERTIFICATE-----
`

const DNS_ONLY_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3m90WTrBk/+2L
eSP/UxGEv/zYSqx9Ngq4FVO4QGnqCJIxgSlEeeX5pUtikd52dwIr/mF0/WnxhPgM
LhUReaJteUawrB3rpeFoTMY79hU0n99WjwBb5DCZfesq7rf8AiebMapsXPj1p/Fw
jTnx1fA3RXfKDkZPBWG99ZTsF3zvde8OUtmV92juEvNeHMdupTN9qoGAAppYZ3oK
PfLyeHZ3mClWTWzHx2uE2QnvAka+YOFpW30PBdfIHHXR1DiVs8kIqEWj55pjp/Cv
K3tCTkmrruj14CvsG69VZffH3NXo/AbLJSiBNq2W3kUZ34Q4jZyH+xyo6MlZ2SJy
CfTO5MbbAgMBAAECggEAPaE1rr0u/FfjdkNtT9CkOrjut/MovsabBnsyJNCKPKIv
4CoInhGEni1bhnSMBZugwP+b2tcM7qLBV+VH8Ruw56ojjj3XtTdy172ddJb/OzDG
mJlbd3y6y2q2uyxx2Ucn4DHlkIYMkviSVEMzRfeXsBXDRbFQ7ElUK5z5Jd4kc4PC
X0pu6+ObTBXoi+4R0Od7pzvWhlTc7xS6SZtDct5canAmwJEBgE07dllqS6jtjJ83
BaoCb6A/5BTfZAWOmiR8+aOuFcmw6MqL4F5sFXG/6nXRONYv+5dSXamTBGdZwoqp
jqlXacAjYMw4fr4csCZ1xXHTbPhfVjKCKr8QF4bzsQKBgQDtF9UPa8GA0o9syc8s
NKtuyL6se2eNSnSk6EbWOhDu6OoIpJJfUUC0XAKkEd88CgvAi6RxIvKRY4DoQzvQ
hhAcpKEHVvJaFkvebi+0D/JwZ+GT6yJxLOOltyM7DC1hGNTcLT2IvF+kYPYeDt9C
u6gZ52a5T9Uhekeucn7+lFRo3QKBgQDGQCuOpblZY8SkL9GH94LH6QodkE7zaAC8
J6ZKJrq43hBnTUGIqjAW2ObGoMtUAIx65/2RdEWN47PhnYbZmWnqXsKzwG1XXKhV
z2AiS8bftaR3G9Tsylo0nmC1E3NV4dBNuSA6RyNFb1qUcmF7QMOlcpHpK0Y0hD1P
cS34FXmXFwKBgQCJR+JjInaRm9nWGOgvZXPaGrxk7LNh2Tm+/ot9oXOKkixowrnK
HScFB72zuHF0tzBk1bZql9yyGFZcpgltTSLpIt3mfQ6o4P4fFdfjP9SWB2BTILP5
qg9KNcddekiQTyt5LWzSzpfmewonD19wqW3FSfpt1G7JCp+Uv9EOoV5atQKBgGkr
u6+2DQj122i6kW6PCIsi/qHGX4vTHaizZA0sVJwj+hHDM0Pb/RzxviObQ6JxlBTT
o3oZc5idNl03I0WmlECoOqP/LkJNPmQfWkF3b65X/0LMuf1QL+CAMI9/HQ1veQDy
d71S5cw9EZF0yHAJYIERsYQ/18Oeb6QIR7m3MsTLAoGASXgAFKvXHXsA8/CdpkC0
dIVAj+BSUma9BgVv+9zFz7DI9QqyJoKZDlEWcdADFz9FCzcZxXKbK8ZxpdliKlDd
TnWPZpslSm1ox3WuvViQK9CvmqJCxDzQkFHyfxsgIxTrzs/TXDnYiTYMPwv1fGqs
YXakA6KwN23uwED7i78CkQM=
-----END PRIVATE KEY-----
`

const DNS_ONLY_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(DNS_ONLY_CERT).fingerprint256,
)

describe('packages/net/tls', () => {
  describe('normalizeFingerprintSha256', () => {
    it('uppercase and colons', () => {
      expect(normalizeFingerprintSha256('aa-bb-cc')).toBe('AA:BB:CC')
    })

    it('empty string', () => {
      expect(normalizeFingerprintSha256('')).toBe('')
    })

    it('already normalized fingerprint', () => {
      expect(normalizeFingerprintSha256('AA:BB:CC')).toBe('AA:BB:CC')
    })

    it('trims whitespace', () => {
      expect(normalizeFingerprintSha256('  AA:BB  ')).toBe('AA:BB')
    })
  })

  // ─── isTlsTrustError — canonical, NARROW trust-failure matcher ─────────────

  describe('isTlsTrustError', () => {
    const withCode = (code: string, message = 'connect failed') => {
      const e = new Error(message) as Error & { code: string }
      e.code = code
      return e
    }

    it('matches OpenSSL / Node certificate error codes', () => {
      expect(isTlsTrustError(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe(true)
      expect(isTlsTrustError(withCode('SELF_SIGNED_CERT_IN_CHAIN'))).toBe(true)
      expect(isTlsTrustError(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(true)
      expect(isTlsTrustError(withCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe(true)
      expect(isTlsTrustError(withCode('CERT_HAS_EXPIRED'))).toBe(true)
      expect(isTlsTrustError(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe(true)
    })

    it('matches full OpenSSL phrases even when a library prefixes them', () => {
      expect(isTlsTrustError(new Error('LOGIN aborted: self-signed certificate'))).toBe(true)
      expect(isTlsTrustError(new Error('unable to verify the first certificate'))).toBe(true)
      expect(isTlsTrustError(new Error("Hostname/IP does not match certificate's altnames: Host: a.b"))).toBe(true)
      expect(isTlsTrustError(new Error('TLS pin mismatch: AA:BB'))).toBe(true)
      expect(isTlsTrustError(new Error('TLS pin error: server certificate fingerprint is empty'))).toBe(true)
    })

    it('does NOT match responses that merely mention a certificate', () => {
      // The old regex had a bare `certificate` alternative — an auth/policy
      // rejection classified as a TLS trust failure, suppressing OAuth token
      // refresh and popping a misleading interception dialog.
      expect(isTlsTrustError(new Error('NO [AUTHENTICATIONFAILED] client certificate required'))).toBe(false)
      expect(isTlsTrustError(new Error('certificate-based authentication is disabled'))).toBe(false)
      expect(isTlsTrustError(new Error('unknown altname handling'))).toBe(false)
    })

    it('does not match transport failures', () => {
      expect(isTlsTrustError(withCode('ECONNRESET', 'socket hang up'))).toBe(false)
      expect(isTlsTrustError(withCode('ETIMEDOUT', 'connect ETIMEDOUT'))).toBe(false)
      expect(isTlsTrustError(new Error('TLS certificate probe timeout'))).toBe(false)
      expect(isTlsTrustError(undefined)).toBe(false)
    })
  })

  // ─── Combined CA store (Node default roots + OS system roots) ─────────────

  describe('getCombinedCaCertificates', () => {
    beforeEach(() => {
      __resetCombinedCaCacheForTest()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      __resetCombinedCaCacheForTest()
    })

    it('builds from DEFAULT roots (not bundled) plus system roots', () => {
      // Regression: starting from 'bundled' dropped NODE_EXTRA_CA_CERTS, so
      // passing `ca` could make trust NARROWER than Node's own default — the
      // opposite of the additive-only guarantee. 'default' already contains
      // bundled + extra, so the result is a strict superset of the default.
      const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        if (type === 'default') return ['BUNDLED-1', 'BUNDLED-2', 'EXTRA-1']
        if (type === 'system') return ['SYSTEM-1']
        if (type === 'bundled') return ['BUNDLED-1', 'BUNDLED-2']
        return []
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toEqual(['BUNDLED-1', 'BUNDLED-2', 'EXTRA-1', 'SYSTEM-1'])
      expect(spy).toHaveBeenCalledWith('default')
      expect(spy).not.toHaveBeenCalledWith('bundled')
    })

    it('de-duplicates roots present in both sets', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        if (type === 'default') return ['ROOT-A', 'ROOT-B']
        if (type === 'system') return ['ROOT-B\n', 'ROOT-C']
        return []
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toEqual(['ROOT-A', 'ROOT-B', 'ROOT-C'])
    })

    it('returns a defensive copy — a mutating consumer cannot corrupt the cache', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const first = getCombinedCaCertificates()!
      first.length = 0
      first.push('ATTACKER-ROOT')

      const second = getCombinedCaCertificates()!
      expect(second).toEqual(['D', 'S'])
      expect(second).not.toBe(first)
    })

    it('caches within the TTL and re-reads the store after it expires', () => {
      vi.useFakeTimers()
      const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toEqual(['D', 'S'])
      expect(getCombinedCaCertificates()).toEqual(['D', 'S'])
      expect(spy).toHaveBeenCalledTimes(2) // default + system, once each

      // Admin removes a root mid-session: after the TTL the change must be
      // picked up without an app restart (a removed interception root must
      // not stay trusted for the whole process lifetime).
      spy.mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : []
      }) as typeof tls.getCACertificates)
      vi.advanceTimersByTime(CA_CACHE_TTL_MS + 1)

      expect(getCombinedCaCertificates()).toEqual(['D'])
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('falls back to null when tls.getCACertificates throws', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('boom')
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toBeNull()
      // Cached null: second call does not warn again
      expect(getCombinedCaCertificates()).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('falls back to null when tls.getCACertificates is absent (old Node)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const original = tls.getCACertificates
      // Simulate a Node build predating tls.getCACertificates
      delete (tls as { getCACertificates?: unknown }).getCACertificates
      try {
        expect(getCombinedCaCertificates()).toBeNull()
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        const restorable = tls as { getCACertificates?: unknown }
        restorable.getCACertificates = original
      }
    })

    it('real Node runtime: combined set is a superset of the default set', () => {
      // No mocks — sanity-check the actual runtime (Node >= 22.15 in dev/CI).
      // Skip silently on runtimes without the API (fallback covered above).
      const getCa = (tls as { getCACertificates?: (t?: string) => string[] }).getCACertificates
      if (typeof getCa !== 'function') return
      const combined = getCombinedCaCertificates()
      expect(combined).not.toBeNull()
      const have = new Set(combined!.map((p) => p.trim()))
      for (const pem of getCa('default')) expect(have.has(pem.trim())).toBe(true)
    })
  })

  describe('getBundledCaCertificates', () => {
    beforeEach(() => {
      __resetCombinedCaCacheForTest()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      __resetCombinedCaCacheForTest()
    })

    it('returns exactly the bundled Mozilla roots', () => {
      const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        if (type === 'bundled') return ['BUNDLED-1', 'BUNDLED-2']
        return ['SHOULD-NOT-APPEAR']
      }) as typeof tls.getCACertificates)

      expect(getBundledCaCertificates()).toEqual(['BUNDLED-1', 'BUNDLED-2'])
      expect(spy).toHaveBeenCalledWith('bundled')
    })

    it('falls back to null when the API is unavailable', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      expect(getBundledCaCertificates()).toBeNull()
    })

    it('the once-per-process fallback warning is shared across the combined AND bundled snapshots', () => {
      // caFallbackWarned is a single module-level flag, not keyed per CaKind.
      // If it were per-kind, the bundled snapshot failing for the first time
      // (after the combined snapshot already warned) would warn again.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toBeNull()
      expect(getBundledCaCertificates()).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('buildTlsOptions', () => {
    /**
     * §2.156 — the trust set now leaves `buildTlsOptions` as a prebuilt shared
     * `secureContext` instead of a `ca` array, so the assertions about WHICH
     * certificates are trusted read the array handed to `tls.createSecureContext`.
     *
     * Stubbing it is required, not merely convenient: these tests use sentinel
     * strings ('D', 'S', 'PINNED-PEM') that real OpenSSL would reject as PEM.
     */
    let caPassedToContext: () => string[] | undefined
    let contextCalls: () => number

    beforeEach(() => {
      __resetCombinedCaCacheForTest()
      const seen: Array<string[] | undefined> = []
      vi.spyOn(tls, 'createSecureContext').mockImplementation(((opts?: { ca?: string | string[] }) => {
        const ca = opts?.ca
        seen.push(typeof ca === 'string' ? [ca] : ca)
        return { __stub: true } as unknown as tls.SecureContext
      }) as typeof tls.createSecureContext)
      caPassedToContext = () => seen[seen.length - 1]
      contextCalls = () => seen.length
    })

    afterEach(() => {
      vi.restoreAllMocks()
      __resetCombinedCaCacheForTest()
    })

    it('without pins includes combined CA and states rejectUnauthorized: true', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({})
      expect(opts).toBeDefined()
      expect(opts!.secureContext).toBeDefined()
      expect(caPassedToContext()).toEqual(['D', 'S'])
      // Critical: verification is NOT weakened. rejectUnauthorized is stated
      // explicitly (no reliance on a transport library's default) and there is
      // no checkServerIdentity override on the no-pin path.
      expect(opts!.rejectUnauthorized).toBe(true)
      expect(opts!.checkServerIdentity).toBeUndefined()
    })

    it('without pins and without system CA support returns undefined (Node default)', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      expect(buildTlsOptions({})).toBeUndefined()
    })

    it('with TLS pins — full verification stays ON and the fingerprint is checked', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const pin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({ tlsPinsSha256: [pin] })
      expect(opts).toBeDefined()
      // BLOCKER regression: the pinned path used to pass
      // rejectUnauthorized:false, which made Node skip checkServerIdentity
      // entirely for self-signed / untrusted chains — pinning was fail-OPEN
      // exactly where it was supposed to protect.
      expect(opts!.rejectUnauthorized).toBe(true)
      expect(caPassedToContext()).toEqual(['D', 'S'])
      expect(opts!.checkServerIdentity).toBeInstanceOf(Function)

      // Correct pin — no error
      const certOk = { fingerprint256: pin, subjectaltname: 'DNS:example.com' } as unknown as tls.PeerCertificate
      expect(opts!.checkServerIdentity!('example.com', certOk)).toBeUndefined()

      // Incorrect pin — error
      const certBad = { fingerprint256: 'XX:YY', subjectaltname: 'DNS:example.com' } as unknown as tls.PeerCertificate
      const err = opts!.checkServerIdentity!('example.com', certBad)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('TLS pin mismatch')
    })

    it('with pins — pinned certificate PEMs are appended as extra trust anchors', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['PINNED-PEM'] })
      // Additive: the anchor only widens chain building, and the fingerprint
      // check still narrows acceptance to the pinned leaf.
      expect(caPassedToContext()).toEqual(['D', 'S', 'PINNED-PEM'])
      expect(opts!.rejectUnauthorized).toBe(true)
    })

    it('with pins and no CA API — trust narrows to the pinned anchors only', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['PINNED-PEM'] })
      expect(caPassedToContext()).toEqual(['PINNED-PEM'])
      expect(opts!.rejectUnauthorized).toBe(true)
    })

    it('with empty certificate fingerprint — pin error', () => {
      const opts = buildTlsOptions({ tlsPinsSha256: ['AA:BB'] })
      const cert = { fingerprint256: '', subjectaltname: 'DNS:example.com' } as unknown as tls.PeerCertificate
      const err = opts!.checkServerIdentity!('example.com', cert)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('fingerprint is empty')
    })

    // ─── servername (DNS fallback / IP connection) ─────────────────────────

    it('servername without pins — returns servername plus combined CA', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({ servername: 'smtp.gmail.com' })
      expect(opts).toBeDefined()
      expect(opts!.servername).toBe('smtp.gmail.com')
      expect(caPassedToContext()).toEqual(['D', 'S'])
      expect(opts!.rejectUnauthorized).toBe(true)
    })

    it('servername without pins, no system CA support — servername plus strict verification', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({ servername: 'smtp.gmail.com' })
      expect(opts).toEqual({ rejectUnauthorized: true, servername: 'smtp.gmail.com' })
    })

    // ─── §2.156 shared SecureContext ───────────────────────────────────────

    it('reuses ONE SecureContext across connections to the same trust set', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      // The stall this fixes: `ca: string[]` made Node parse and index every
      // certificate in the array before EVERY handshake, ~14ms for the ~240-cert
      // combined store. The background pass opens one connection per folder, so
      // that was ~630ms of main-thread work every five minutes.
      const first = buildTlsOptions({})!
      for (let i = 0; i < 43; i++) buildTlsOptions({})
      expect(contextCalls()).toBe(1)
      expect(buildTlsOptions({})!.secureContext).toBe(first.secureContext)
    })

    it('a CA snapshot refresh rebuilds the context — staleness stays bounded by the TTL', () => {
      vi.useFakeTimers()
      try {
        const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
          return type === 'default' ? ['D'] : ['S']
        }) as typeof tls.getCACertificates)

        const before = buildTlsOptions({})!
        expect(contextCalls()).toBe(1)

        // Admin removes the interception root. The whole point of CA_CACHE_TTL_MS
        // is that this takes effect without a restart; a context cached for the
        // process lifetime would have kept the removed root trusted, which is
        // exactly the hole this test exists to keep closed.
        spy.mockImplementation(((type?: string) => (type === 'default' ? ['D'] : [])) as typeof tls.getCACertificates)
        vi.advanceTimersByTime(CA_CACHE_TTL_MS + 1)

        const after = buildTlsOptions({})!
        expect(contextCalls()).toBe(2)
        expect(caPassedToContext()).toEqual(['D'])
        expect(after.secureContext).not.toBe(before.secureContext)
      } finally {
        vi.useRealTimers()
      }
    })

    it('different pinned anchors get different contexts — no trust bleeds between endpoints', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const a = buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['ANCHOR-A'] })!
      expect(caPassedToContext()).toEqual(['D', 'S', 'ANCHOR-A'])
      const b = buildTlsOptions({ tlsPinsSha256: ['CC:DD'], tlsPinnedCertsPem: ['ANCHOR-B'] })!
      expect(caPassedToContext()).toEqual(['D', 'S', 'ANCHOR-B'])
      expect(a.secureContext).not.toBe(b.secureContext)
      // An unpinned endpoint must not receive either anchored context.
      const plain = buildTlsOptions({})!
      expect(plain.secureContext).not.toBe(a.secureContext)
      expect(plain.secureContext).not.toBe(b.secureContext)
      // Same anchors again → the cached context, not a fourth build.
      const callsBefore = contextCalls()
      expect(buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['ANCHOR-A'] })!.secureContext)
        .toBe(a.secureContext)
      expect(contextCalls()).toBe(callsBefore)
    })

    it('a cache hit within the TTL does not bump the revision — repeated calls stay on ONE context', () => {
      // Populate the shared 'combined' snapshot through the PUBLIC getter
      // first, then drive buildTlsOptions() off the SAME cache entry. If a
      // TTL hit minted a fresh revision on every read, every subsequent
      // buildTlsOptions() call would get a different cache key and rebuild
      // the context on every connection — exactly the cost this cache exists
      // to remove (see the §2.156 comment above `secureContextCache`).
      const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toEqual(['D', 'S'])
      spy.mockClear()

      const first = buildTlsOptions({})!
      const second = buildTlsOptions({})!
      expect(spy).not.toHaveBeenCalled() // still within the TTL — no recompute
      expect(contextCalls()).toBe(1)
      expect(second.secureContext).toBe(first.secureContext)
    })

    it('anchor sets that would collide under naive concatenation still get different context keys', () => {
      // anchorsKey() hashes with a NUL separator between PEM bodies precisely
      // so that ['AB', 'C'] and ['A', 'BC'] cannot hash to the same digest.
      // Without the separator the second call below would hit the cache
      // entry built for the FIRST (different) anchor set and silently reuse
      // the wrong trust store.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['AB', 'C'] })
      expect(contextCalls()).toBe(1)
      buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['A', 'BC'] })
      expect(contextCalls()).toBe(2)
    })

    it('a revision bump sweeps ALL stale-revision entries out of the cache, not just the one being looked up', () => {
      // §2.156: without this sweep the cache would grow by (accounts ×
      // revisions) for the whole process lifetime — a new root-store snapshot
      // every CA_CACHE_TTL_MS orphans every context built from the previous
      // one, and nothing else ever removes them.
      vi.useFakeTimers()
      try {
        const spyCa = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
          return type === 'default' ? ['D'] : ['S']
        }) as typeof tls.getCACertificates)

        // Three distinct trust sets built in revision 1: two pinned accounts
        // plus the plain unpinned one.
        buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: ['ANCHOR-A'] })
        buildTlsOptions({ tlsPinsSha256: ['CC:DD'], tlsPinnedCertsPem: ['ANCHOR-B'] })
        buildTlsOptions({})
        expect(contextCalls()).toBe(3)

        // Admin removes a root; TTL expires — revision bumps.
        spyCa.mockImplementation(((type?: string) => {
          return type === 'default' ? ['D2'] : ['S']
        }) as typeof tls.getCACertificates)
        vi.advanceTimersByTime(CA_CACHE_TTL_MS + 1)

        const originalDelete = Map.prototype.delete
        const deleteSpy = vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown,
        ): boolean {
          return originalDelete.call(this, key)
        })

        // ONE new-revision lookup must sweep all three stale entries.
        buildTlsOptions({})
        expect(deleteSpy).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('__resetCombinedCaCacheForTest also clears the SecureContext cache (test isolation)', () => {
      // §2.156 extended the reset helper to clear secureContextCache alongside
      // caCache. A regression that dropped that line would leak one context
      // per test run for the lifetime of this suite (see the sweep test
      // above for why the leak is otherwise invisible from the outside: the
      // ever-climbing revision counter alone already prevents a stale HIT).
      const originalClear = Map.prototype.clear
      const clearSpy = vi.spyOn(Map.prototype, 'clear').mockImplementation(function (
        this: Map<unknown, unknown>,
      ): void {
        return originalClear.call(this)
      })

      __resetCombinedCaCacheForTest()

      expect(clearSpy).toHaveBeenCalledTimes(2) // caCache.clear() + secureContextCache.clear()
    })

    it('the once-per-process CA-fallback warning also covers buildTlsOptions() failures, verification stays strict', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      const noPins = buildTlsOptions({})
      const withSni = buildTlsOptions({ servername: 'smtp.gmail.com' })!
      const withPins = buildTlsOptions({ tlsPinsSha256: ['AA:BB'] })!

      // No trust store to hand over: either the whole options object is
      // omitted (Node's own default verification, still secure) or
      // rejectUnauthorized is stated explicitly — never left unset/weakened.
      expect(noPins).toBeUndefined()
      expect(withSni.rejectUnauthorized).toBe(true)
      expect(withSni.secureContext).toBeUndefined()
      expect(withPins.rejectUnauthorized).toBe(true)
      expect(withPins.secureContext).toBeUndefined()
      // Warned exactly once across three independent buildTlsOptions() calls.
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('sharing one SecureContext across two endpoints does not leak servername or pin identity between them', () => {
      // The whole point of moving the trust store out of per-connection
      // options and into a shared context: rejectUnauthorized, servername and
      // checkServerIdentity MUST stay per-call, or one account's identity
      // policy would silently apply to another account's connection.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const rendererPinB = 'AA:BB:CC:DD'
      const a = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'account-a.example.com',
      })!
      const b = buildTlsOptions({
        // Same anchor as `a` (same trust set → same shared context) PLUS an
        // extra fingerprint-only pin that `a` does not have.
        tlsPinsSha256: [SELF_SIGNED_FP, rendererPinB],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'account-b.example.com',
      })!

      // Same trust set → the underlying context IS shared, that is the
      // feature this cache exists for...
      expect(b.secureContext).toBe(a.secureContext)
      // ...but every per-connection option is still built fresh from THIS
      // call's cfg, not memoized alongside the context.
      expect(a.servername).toBe('account-a.example.com')
      expect(b.servername).toBe('account-b.example.com')
      expect(a.checkServerIdentity).not.toBe(b.checkServerIdentity)

      // Behavioural proof, not just reference inequality: a certificate
      // matching B's extra renderer pin is accepted by B...
      const rendererCert = {
        fingerprint256: rendererPinB,
        subjectaltname: 'DNS:account-b.example.com',
      } as unknown as tls.PeerCertificate
      expect(b.checkServerIdentity!('1.2.3.4', rendererCert)).toBeUndefined()
      // ...but REJECTED by A as a pin mismatch — A never learned that pin;
      // sharing the SecureContext did not smuggle it across.
      const err = a.checkServerIdentity!('1.2.3.4', rendererCert)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('TLS pin mismatch')
    })

    it('servername + pins — servername is still sent as SNI', () => {
      const pin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({
        tlsPinsSha256: [pin],
        servername: 'smtp.gmail.com',
      })
      expect(opts).toBeDefined()
      expect(opts!.servername).toBe('smtp.gmail.com')

      const cert = {
        fingerprint256: pin,
        subjectaltname: 'DNS:smtp.gmail.com',
      } as unknown as tls.PeerCertificate

      // Called with the IP as `hostname` — the pinned leaf is what authorizes
      // the connection, so this resolves to "accepted".
      const result = opts!.checkServerIdentity!('1.2.3.4', cert)
      expect(result).toBeUndefined()
    })

    it('ANCHORED pin + no matching name — accepted, the name check is not consulted', () => {
      // §2.52 regression: the pinned callback checked the hostname FIRST and
      // returned its error before comparing fingerprints, so an endpoint whose
      // certificate does not carry the dialled name (bare-IP host — the very
      // case pinning exists for) could never be recovered: the user pressed
      // "Trust" and the next connection failed identically.
      const identitySpy = vi.spyOn(tls, 'checkServerIdentity')
      const opts = buildTlsOptions({
        tlsPinsSha256: [DNS_ONLY_FP],
        tlsPinnedCertsPem: [DNS_ONLY_CERT],
        servername: 'smtp.gmail.com',
      })

      const cert = {
        fingerprint256: DNS_ONLY_FP,
        subjectaltname: 'DNS:mail.example.test',
      } as unknown as tls.PeerCertificate

      expect(opts!.checkServerIdentity!('1.2.3.4', cert)).toBeUndefined()
      // Not "the name happened to match": for an anchored leaf the name check
      // is not reached at all. Guard against a future re-introduction.
      expect(identitySpy).not.toHaveBeenCalled()
    })

    it('FINGERPRINT-ONLY pin + no matching name — REFUSED (renderer-writable pins may not redirect identity)', () => {
      // The security boundary that makes the mode split necessary: `tls:addPin`
      // is a plain renderer IPC channel with no trust-offer gate, so a
      // compromised renderer can choose this fingerprint. Skipping the name
      // check for it would turn a pin from a narrowing of trust into a
      // REDIRECTION of it — any CA-valid certificate whose fingerprint the
      // renderer wrote would be accepted as this mail host.
      const pin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({
        tlsPinsSha256: [pin],
        servername: 'smtp.gmail.com',
      })

      const cert = {
        fingerprint256: pin,
        subjectaltname: 'DNS:attacker.example.com',
      } as unknown as tls.PeerCertificate

      const err = opts!.checkServerIdentity!('1.2.3.4', cert)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toMatch(/altnames|subject/i)
      expect(isTlsTrustError(err)).toBe(true)
    })

    it('FINGERPRINT-ONLY pin + matching name — accepted (pin narrows, it does not block)', () => {
      const pin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({
        tlsPinsSha256: [pin],
        servername: 'smtp.gmail.com',
      })

      const cert = {
        fingerprint256: pin,
        subjectaltname: 'DNS:smtp.gmail.com',
      } as unknown as tls.PeerCertificate

      expect(opts!.checkServerIdentity!('1.2.3.4', cert)).toBeUndefined()
    })

    it('MIXED endpoint — the anchor privilege belongs to the anchored leaf only', () => {
      // One anchored pin (recovery dialog) plus one fingerprint-only pin
      // (Settings) on the same endpoint. A per-endpoint "has anchors" flag
      // would hand the anchored certificate's privilege to the renderer-chosen
      // one; the discriminator is therefore per presented certificate.
      const rendererPin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({
        tlsPinsSha256: [DNS_ONLY_FP, rendererPin],
        tlsPinnedCertsPem: [DNS_ONLY_CERT],
        servername: 'smtp.gmail.com',
      })

      // Anchored leaf → accepted despite naming a different host.
      const anchored = {
        fingerprint256: DNS_ONLY_FP,
        subjectaltname: 'DNS:mail.example.test',
      } as unknown as tls.PeerCertificate
      expect(opts!.checkServerIdentity!('1.2.3.4', anchored)).toBeUndefined()

      // Fingerprint-only leaf on the SAME endpoint → still name-checked.
      const fingerprintOnly = {
        fingerprint256: rendererPin,
        subjectaltname: 'DNS:attacker.example.com',
      } as unknown as tls.PeerCertificate
      const err = opts!.checkServerIdentity!('1.2.3.4', fingerprintOnly)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toMatch(/altnames|subject/i)
    })

    it('unparsable stored anchor grants no identity — falls back to the name check', () => {
      // Corrupt pin row (packages/db validates on write, so this is a
      // repair-path). It must degrade to hostname-checked, never to "anchored".
      const pin = 'AA:BB:CC:DD'
      const opts = buildTlsOptions({
        tlsPinsSha256: [pin],
        tlsPinnedCertsPem: ['-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'],
        servername: 'smtp.gmail.com',
      })

      const cert = {
        fingerprint256: pin,
        subjectaltname: 'DNS:attacker.example.com',
      } as unknown as tls.PeerCertificate

      expect(opts!.checkServerIdentity!('1.2.3.4', cert)).toBeInstanceOf(Error)
    })

    it('name matches but the pin does NOT — still refused as a pin mismatch', () => {
      // The other half of the inversion: relaxing the NAME check must not
      // relax the FINGERPRINT check. Server-side rotation therefore keeps
      // failing closed and re-raises the recovery dialog.
      const opts = buildTlsOptions({
        tlsPinsSha256: ['AA:BB:CC:DD'],
        servername: 'smtp.gmail.com',
      })

      const rotated = {
        fingerprint256: '11:22:33:44',
        subjectaltname: 'DNS:smtp.gmail.com',
      } as unknown as tls.PeerCertificate

      const err = opts!.checkServerIdentity!('1.2.3.4', rotated)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('TLS pin mismatch')
      expect(isTlsTrustError(err)).toBe(true)
    })
  })

  // ─── END-TO-END: real TLS server with an untrusted certificate ─────────────
  //
  // Calling checkServerIdentity directly (the tests above) can NEVER catch the
  // fail-open blocker: Node only invokes that callback on the branch where
  // chain verification already succeeded. With rejectUnauthorized:false and a
  // self-signed certificate the callback never runs and ANY certificate is
  // accepted. Only a real handshake proves the pin is enforced.

  describe('buildTlsOptions against a real TLS server (untrusted certificate)', () => {
    let server: tls.Server
    let port: number

    beforeEach(async () => {
      __resetCombinedCaCacheForTest()
      server = tls.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (socket) => {
        socket.end('OK\r\n')
      })
      // Rejected handshakes surface here; swallow so they don't crash the run.
      server.on('tlsClientError', () => {})
      server.on('error', () => {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as net.AddressInfo).port
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      __resetCombinedCaCacheForTest()
    })

    /** Attempt a handshake with the given options; never throws. */
    function handshake(opts: tls.ConnectionOptions): Promise<{ ok: boolean; error?: Error }> {
      return new Promise((resolve) => {
        let settled = false
        const done = (r: { ok: boolean; error?: Error }) => {
          if (settled) return
          settled = true
          try { socket.destroy() } catch { /* ignore */ }
          resolve(r)
        }
        const socket = tls.connect({ host: '127.0.0.1', port, ...opts }, () => done({ ok: true }))
        socket.once('error', (e: Error) => done({ ok: false, error: e }))
        socket.setTimeout(5_000, () => done({ ok: false, error: new Error('handshake timeout') }))
      })
    }

    it('pinned + matching pin + pinned PEM anchor → handshake SUCCEEDS', async () => {
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'localhost',
      })!
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('pinned + WRONG pin → handshake REJECTED (the fail-open blocker)', async () => {
      // Pre-fix behaviour: rejectUnauthorized:false made Node skip
      // checkServerIdentity for this self-signed certificate and accept the
      // connection — the pin was decorative.
      const opts = buildTlsOptions({
        tlsPinsSha256: ['00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'localhost',
      })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(r.error?.message).toContain('TLS pin mismatch')
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('pinned + matching pin + servername the certificate does not name → handshake SUCCEEDS', async () => {
      // Behaviour change (P0 fix for the §2.52 regression): on the pinned path
      // the confirmed leaf IS the identity. A name that the certificate does
      // not carry no longer rejects it — otherwise "Trust this certificate"
      // could never fix an endpoint addressed by IP or by a name absent from
      // the certificate, which is precisely what the recovery flow is for.
      // Chain verification and fingerprint equality are untouched.
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'not-the-pinned-host.example',
      })!
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('pinned WITHOUT the certificate PEM → self-signed server fails CLOSED', async () => {
      // Documented consequence of the fix: until the pin store persists the
      // certificate body, a pinned self-signed server no longer connects — it
      // errors like any untrusted chain instead of being silently accepted.
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        servername: 'localhost',
      })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('no pins → untrusted certificate is rejected by the combined CA set', async () => {
      const opts = buildTlsOptions({ servername: 'localhost' })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(isTlsTrustError(r.error)).toBe(true)
    })
  })

  // ─── REGRESSION: account addressed by bare IP, certificate names domains ───
  //
  // The reported P0: `ERR_TLS_CERT_ALTNAME_INVALID: … IP: 31.31.197.22 is not
  // in the cert's list`. The user accepted the certificate in the recovery
  // dialog, the pin was stored — and the very same error came back, because
  // the pinned callback ran the name check first and returned before the
  // fingerprint was ever compared.
  //
  // Served over a real handshake on 127.0.0.1 with NO `servername`, so Node
  // verifies the identity against the IP literal exactly as it does in
  // production for an IP-addressed account.

  describe('bare-IP endpoint whose certificate carries no IP SAN', () => {
    let server: tls.Server
    let port: number

    beforeEach(async () => {
      __resetCombinedCaCacheForTest()
      server = tls.createServer({ key: DNS_ONLY_KEY, cert: DNS_ONLY_CERT }, (socket) => {
        socket.end('OK\r\n')
      })
      server.on('tlsClientError', () => {})
      server.on('error', () => {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as net.AddressInfo).port
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      __resetCombinedCaCacheForTest()
    })

    /**
     * Substitute the trust set of an options object produced by
     * `buildTlsOptions`.
     *
     * §2.156: the trust set travels as a prebuilt shared `secureContext`, and
     * `tls.connect` IGNORES `ca` when a context is supplied — so a test that
     * wants OpenSSL to accept a different anchor set has to rebuild the context.
     * Everything that decides identity (`rejectUnauthorized`, the pinned
     * `checkServerIdentity` closure) is left exactly as produced.
     */
    function withTrust(opts: tls.ConnectionOptions, ca: string[]): tls.ConnectionOptions {
      return { ...opts, secureContext: tls.createSecureContext({ ca }) }
    }

    /** Dial by IP literal, no servername — the production shape of the bug. */
    function handshakeByIp(opts: tls.ConnectionOptions): Promise<{ ok: boolean; error?: Error }> {
      return new Promise((resolve) => {
        let settled = false
        const done = (r: { ok: boolean; error?: Error }) => {
          if (settled) return
          settled = true
          try { socket.destroy() } catch { /* ignore */ }
          resolve(r)
        }
        const socket = tls.connect({ host: '127.0.0.1', port, ...opts }, () => done({ ok: true }))
        socket.once('error', (e: Error) => done({ ok: false, error: e }))
        socket.setTimeout(5_000, () => done({ ok: false, error: new Error('handshake timeout') }))
      })
    }

    it('NOT pinned → still rejected for the name mismatch (unpinned path unchanged)', async () => {
      // The certificate is handed to OpenSSL as a trust anchor so the chain
      // verifies and the ONLY possible failure is the identity check — that is
      // what makes this a control for the pinned test below rather than a
      // re-test of chain verification. `ca` is the sole substitution; the
      // rest of the object is what buildTlsOptions produces for an unpinned
      // endpoint (rejectUnauthorized: true, no checkServerIdentity override).
      const unpinned = buildTlsOptions({})!
      expect(unpinned.checkServerIdentity).toBeUndefined()
      const r = await handshakeByIp(withTrust(unpinned, [DNS_ONLY_CERT]))
      expect(r.ok).toBe(false)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('pinned to this exact certificate → handshake SUCCEEDS despite the name mismatch', async () => {
      const opts = buildTlsOptions({
        tlsPinsSha256: [DNS_ONLY_FP],
        tlsPinnedCertsPem: [DNS_ONLY_CERT],
      })!
      const r = await handshakeByIp(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('pinned by FINGERPRINT ONLY → still rejected for the name mismatch (the renderer-pin BLOCKER)', async () => {
      // Models the attack the mode split closes: a compromised renderer writes
      // a fingerprint through `tls:addPin` (no trust-offer gate, no PEM) for a
      // certificate that IS publicly valid — here simulated by handing that
      // certificate to OpenSSL as a root, which is what a real CA-issued
      // attacker certificate amounts to. Chain verification therefore passes
      // and the only thing standing between the user and a MITM is this
      // hostname check.
      const opts = buildTlsOptions({ tlsPinsSha256: [DNS_ONLY_FP] })!
      const r = await handshakeByIp(
        withTrust(opts, [...(getCombinedCaCertificates() ?? []), DNS_ONLY_CERT]),
      )
      expect(r.ok).toBe(false)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('MIXED endpoint over a real handshake — a fingerprint-only leaf borrows nothing from the anchored one', async () => {
      // Anchored pin for one certificate + fingerprint-only pin for another,
      // on the same endpoint. The server presents the fingerprint-only one.
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP, DNS_ONLY_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })!
      const r = await handshakeByIp(
        withTrust(opts, [...(getCombinedCaCertificates() ?? []), SELF_SIGNED_CERT, DNS_ONLY_CERT]),
      )
      expect(r.ok).toBe(false)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    })

    it('pinned to a DIFFERENT certificate → rejected as a pin mismatch, not as a name mismatch', async () => {
      // Server-side rotation while the host is addressed by IP: both failures
      // apply, and the pin verdict must be the one reported — it is the reason
      // the connection is refused, and it is what re-raises the recovery
      // dialog for the new certificate.
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT, DNS_ONLY_CERT],
      })!
      const r = await handshakeByIp(opts)
      expect(r.ok).toBe(false)
      expect(r.error?.message).toContain('TLS pin mismatch')
      expect(r.error?.message).toContain(DNS_ONLY_FP)
      expect(isTlsTrustError(r.error)).toBe(true)
    })
  })

  // ─── verifyCertTrust — local TLS interception probe ────────────────────────

  describe('verifyCertTrust', () => {
    const fakeCert = {
      fingerprint256: 'aa:bb:cc',
      issuer: { CN: 'Kaspersky Anti-Virus Personal Root Certificate' },
      subject: { CN: 'imap.example.com' },
    }

    class FakeTlsSocket extends EventEmitter {
      private readonly cert: Record<string, unknown>
      constructor(cert: Record<string, unknown> = fakeCert) {
        super()
        this.cert = cert
      }
      getPeerCertificate = vi.fn(() => this.cert)
      setTimeout = vi.fn()
      end = vi.fn()
      destroy = vi.fn()
    }

    /**
     * Connection behaviours:
     *  'ok'                    — handshake succeeds with the default cert
     *  { ok: {...} }           — handshake succeeds with an overridden cert
     *  'cert-fail'             — OpenSSL chain-verification rejection; the
     *                            error carries NO certificate (measured Node
     *                            behaviour for DEPTH_ZERO_SELF_SIGNED_CERT /
     *                            UNABLE_TO_VERIFY_LEAF_SIGNATURE)
     *  { certFail: {...} }     — checkServerIdentity-branch rejection, where
     *                            Node DOES attach `err.cert`
     *  'net-fail'              — transport failure
     */
    type Behavior =
      | 'ok'
      | 'cert-fail'
      | 'net-fail'
      | { ok: { fingerprint256: string } }
      | { certFail: { fingerprint256: string } }

    /** Mock tls.connect: behaviors[i] drives the i-th connection. */
    function mockConnectSequence(behaviors: Behavior[]) {
      let call = 0
      const capturedOptions: tls.ConnectionOptions[] = []
      const spy = vi.spyOn(tls, 'connect').mockImplementation(((
        opts: tls.ConnectionOptions,
        cb?: () => void,
      ) => {
        const behavior = behaviors[Math.min(call, behaviors.length - 1)]
        call++
        capturedOptions.push(opts)
        const succeeds = behavior === 'ok' || (typeof behavior === 'object' && 'ok' in behavior)
        const cert = typeof behavior === 'object' && 'ok' in behavior
          ? { ...fakeCert, ...behavior.ok }
          : fakeCert
        const socket = new FakeTlsSocket(cert)
        queueMicrotask(() => {
          if (succeeds) {
            cb?.()
          } else if (typeof behavior === 'object' && 'certFail' in behavior) {
            const e = new Error("Hostname/IP does not match certificate's altnames: Host: x") as Error & {
              code: string
              cert: Record<string, unknown>
            }
            e.code = 'ERR_TLS_CERT_ALTNAME_INVALID'
            e.cert = { ...fakeCert, ...behavior.certFail }
            socket.emit('error', e)
          } else if (behavior === 'cert-fail') {
            const e = new Error('unable to verify the first certificate') as Error & { code: string }
            e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
            socket.emit('error', e)
          } else {
            const e = new Error('connect ETIMEDOUT') as Error & { code: string }
            e.code = 'ETIMEDOUT'
            socket.emit('error', e)
          }
        })
        return socket as unknown as tls.TLSSocket
      }) as typeof tls.connect)
      return { spy, capturedOptions }
    }

    function mockCa(system: string[] = ['S']) {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        if (type === 'bundled') return ['B']
        if (type === 'default') return ['B', 'E']
        if (type === 'system') return system
        return []
      }) as typeof tls.getCACertificates)
    }

    beforeEach(() => {
      __resetCombinedCaCacheForTest()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      __resetCombinedCaCacheForTest()
    })

    it('system-only verdict when the chain fails bundled roots but passes default+system', async () => {
      mockCa()
      // probe 1 (identity) ok, probe 2 (bundled) cert-rejected WITHOUT a
      // fingerprint (OpenSSL verify code), probe 3 ok, probe 4 confirmation.
      const { spy, capturedOptions } = mockConnectSequence(['ok', 'cert-fail', 'ok', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report).toEqual({
        fingerprintSha256: 'AA:BB:CC',
        issuerCn: 'Kaspersky Anti-Virus Personal Root Certificate',
        subjectCn: 'imap.example.com',
        systemOnly: true,
        verdict: 'system-only',
        conclusive: true,
        // The bundled rejection never named its certificate (OpenSSL verify
        // code), so the verdict is warn-worthy but must not be persisted.
        evidence: 'partial',
      })
      // 4 connections: the rejecting probe proved nothing about WHICH
      // certificate it rejected, so the identity is re-read and required to
      // be unchanged before a conclusive verdict is issued.
      expect(spy).toHaveBeenCalledTimes(4)
      expect(capturedOptions[3].rejectUnauthorized).toBe(false)
      // Identity probe is the ONLY connection allowed rejectUnauthorized:false
      expect(capturedOptions[0].rejectUnauthorized).toBe(false)
      // Verifying probes never weaken verification
      expect(capturedOptions[1].rejectUnauthorized).toBe(true)
      expect(capturedOptions[2].rejectUnauthorized).toBe(true)
      // The "bundled-only" probe passes an EXPLICIT bundled array. Omitting
      // `ca` would have used Node's default store — which also carries
      // NODE_EXTRA_CA_CERTS (and system roots under --use-system-ca), so the
      // probe could silently answer the wrong question.
      expect(capturedOptions[1].ca).toEqual(['B'])
      expect(capturedOptions[2].ca).toEqual(['B', 'E', 'S'])
    })

    it('bundled-trusted verdict when the chain is trusted by bundled roots (no third probe)', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('bundled-trusted')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(true)
      expect(report.fingerprintSha256).toBe('AA:BB:CC')
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('untrusted verdict when the chain is trusted by neither set (plain bad cert)', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'cert-fail', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('untrusted')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(true)
      // Both rejections were fingerprint-less → confirmation probe required.
      expect(spy).toHaveBeenCalledTimes(4)
    })

    // ─── fingerprint on the REJECTION path ─────────────────────────────────
    //
    // Rejected probes used to expose no fingerprint at all, so a rotation
    // landing on the rejecting probe went undetected and a `system-only`
    // verdict could be assembled from two different certificates. Node hands
    // the certificate over on checkServerIdentity-branch rejections
    // (ERR_TLS_CERT_ALTNAME_INVALID) but NOT on OpenSSL chain-verification
    // codes — measured, see HandshakeProbe. Both paths are covered here.

    it('a rejection that carries err.cert takes part in the fingerprint cross-check', async () => {
      mockCa()
      // Bundled probe rejects and reports the SAME certificate → no extra
      // confirmation probe is needed, the rejection proved its own identity.
      const { spy } = mockConnectSequence(['ok', { certFail: { fingerprint256: 'aa:bb:cc' } }, 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('system-only')
      expect(report.conclusive).toBe(true)
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it('rotation detected on the REJECTING probe via err.cert → certificate-rotated', async () => {
      mockCa()
      // Identity probe saw AA:BB:CC; the bundled probe rejected a DIFFERENT
      // certificate. Pre-fix this was invisible and the run produced a
      // confident system-only verdict built from two certificates.
      const { spy } = mockConnectSequence(['ok', { certFail: { fingerprint256: 'ff:ee:dd' } }, 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('certificate-rotated')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      // Stops immediately — no point probing the combined set.
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('fingerprint-less rejection + certificate changed by the confirmation probe → certificate-rotated', async () => {
      mockCa()
      // The rejecting probe could not prove its certificate (OpenSSL code),
      // and by the time the identity is re-read the endpoint serves another
      // one — the verdict must NOT be reported as system-only.
      const { spy } = mockConnectSequence([
        'ok',
        'cert-fail',
        'ok',
        { ok: { fingerprint256: 'ff:ee:dd' } },
      ])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('certificate-rotated')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('confirmation probe failing on transport → inconclusive, never system-only by default', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'ok', 'net-fail'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('transport-failed')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('no confirmation probe when the verdict never depended on a rejection', async () => {
      mockCa()
      // bundled-trusted: the accepting probe proved its own fingerprint.
      const { spy } = mockConnectSequence(['ok', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('bundled-trusted')
      expect(report.conclusive).toBe(true)
      expect(spy).toHaveBeenCalledTimes(2)
    })

    // The confirmation probe is a COMPENSATING control for rejections that
    // proved nothing. If it treated its own inability to prove anything as
    // "unchanged", it would fail open exactly where it was added to close a
    // hole — so here absence of proof counts as a negative result, unlike in
    // the deliberately lenient `sameCert` used for the ordinary probes.
    it('confirmation probe connects but yields NO fingerprint → inconclusive, not system-only', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'ok', { ok: { fingerprint256: '' } }])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('identity-unconfirmed')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('confirmation probe without a fingerprint also blocks the untrusted verdict', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'cert-fail', { ok: { fingerprint256: '' } }])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('identity-unconfirmed')
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('confirmation probe returning the SAME fingerprint keeps the verdict conclusive', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'ok', { ok: { fingerprint256: 'aa:bb:cc' } }])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('system-only')
      expect(report.systemOnly).toBe(true)
      expect(report.conclusive).toBe(true)
      expect(report.inconclusiveReason).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(4)
    })

    // ─── evidence: warn on 'partial', persist only on 'proven' ─────────────
    //
    // The confirmation probe narrows the rotation race but cannot close it:
    // an endpoint serving cert A to both identity probes and cert B to the
    // rejecting probe passes every check, yet the negative half of the
    // verdict concerned a different certificate. Downgrading such runs to
    // inconclusive would make system-only unreachable in practice (Node
    // never names the certificate on OpenSSL verify codes) and the
    // interception warning would never fire. So the verdict stands, marked
    // 'partial' — enough to warn, not enough for the subscriber to record a
    // lasting "host checked" state that silences future warnings.

    it("system-only resting on a fingerprint-less rejection is marked 'partial'", async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'ok', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('system-only')
      expect(report.conclusive).toBe(true)
      // Subscriber contract: warn — yes; persist as "host checked" — no.
      expect(report.evidence).toBe('partial')
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it("untrusted verdict from fingerprint-less rejections is 'partial'", async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'cert-fail', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('untrusted')
      expect(report.conclusive).toBe(true)
      expect(report.evidence).toBe('partial')
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it("system-only is 'proven' when every contributing probe named its certificate", async () => {
      mockCa()
      // Rejection carries err.cert with the SAME fingerprint → nothing about
      // the verdict is assumed, and no confirmation probe is needed.
      const { spy } = mockConnectSequence(['ok', { certFail: { fingerprint256: 'aa:bb:cc' } }, 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('system-only')
      expect(report.conclusive).toBe(true)
      expect(report.evidence).toBe('proven')
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it("untrusted is 'proven' when both rejections named the same certificate", async () => {
      mockCa()
      const { spy } = mockConnectSequence([
        'ok',
        { certFail: { fingerprint256: 'aa:bb:cc' } },
        { certFail: { fingerprint256: 'aa:bb:cc' } },
      ])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('untrusted')
      expect(report.evidence).toBe('proven')
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it("bundled-trusted is 'proven' — the accepting probe names its own certificate", async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('bundled-trusted')
      expect(report.conclusive).toBe(true)
      expect(report.evidence).toBe('proven')
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it("every inconclusive outcome reports evidence 'partial', never 'proven'", async () => {
      mockCa()
      mockConnectSequence(['ok', 'net-fail'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.evidence).toBe('partial')
    })

    // No verdict may rest on a comparison where BOTH sides are empty: without
    // a known identity there is nothing to display, nothing to pin, and
    // nothing the verdict can be attributed to.
    it('identity probe without a fingerprint → no conclusive verdict, and no pointless confirmation probe', async () => {
      mockCa()
      const { spy } = mockConnectSequence([
        { ok: { fingerprint256: '' } },
        'cert-fail',
        { ok: { fingerprint256: '' } },
      ])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('identity-unconfirmed')
      expect(report.systemOnly).toBe(false)
      expect(report.fingerprintSha256).toBe('')
      // 3 connections: the confirmation probe is skipped — with no baseline
      // fingerprint it could not confirm anything anyway.
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it('identity probe without a fingerprint also blocks a bundled-trusted verdict', async () => {
      mockCa()
      const { spy } = mockConnectSequence([{ ok: { fingerprint256: '' } }, { ok: { fingerprint256: '' } }])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('identity-unconfirmed')
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(2)
    })

    // ─── inconclusive: transport failures must never become a verdict ───────

    it('transport failure on the bundled probe → inconclusive, NOT a false interception alarm', async () => {
      mockCa()
      // Pre-fix: probe 2 collapsed timeout/DNS/TCP failure into `false`, so a
      // transient flap plus a successful probe 3 reported systemOnly: true.
      const { spy } = mockConnectSequence(['ok', 'net-fail', 'ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('transport-failed')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      // No third probe: the chain stops at the first inconclusive step.
      expect(spy).toHaveBeenCalledTimes(2)
    })

    it('transport failure on the combined probe → inconclusive, not a persisted "untrusted"', async () => {
      mockCa()
      const { spy } = mockConnectSequence(['ok', 'cert-fail', 'net-fail'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('transport-failed')
      expect(report.conclusive).toBe(false)
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it('probe timeout is a transport failure, not a certificate rejection', async () => {
      vi.useFakeTimers()
      try {
        mockCa()
        vi.spyOn(tls, 'connect').mockImplementation(((opts: tls.ConnectionOptions, cb?: () => void) => {
          const socket = new FakeTlsSocket()
          // Only the identity probe completes; verifying probes hang.
          if (opts.rejectUnauthorized === false) queueMicrotask(() => cb?.())
          return socket as unknown as tls.TLSSocket
        }) as typeof tls.connect)

        const pending = verifyCertTrust('imap.example.com', 993)
        await vi.advanceTimersByTimeAsync(13_000)
        const report = await pending
        expect(report.verdict).toBe('inconclusive')
        expect(report.inconclusiveReason).toBe('transport-failed')
      } finally {
        vi.useRealTimers()
      }
    })

    it('certificate changing between probes → inconclusive (rotation / active attacker)', async () => {
      mockCa()
      // Identity probe sees cert A; the verifying probe that produces the
      // verdict sees cert B — the UI would otherwise display and pin a
      // certificate that never took part in the trust decision.
      const { spy } = mockConnectSequence(['ok', 'cert-fail', { ok: { fingerprint256: 'ff:ee:dd' } }])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('certificate-rotated')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      expect(report.fingerprintSha256).toBe('AA:BB:CC')
      expect(spy).toHaveBeenCalledTimes(3)
    })

    it('CA store unavailable → inconclusive (no reference set, no verdict)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)
      const { spy } = mockConnectSequence(['ok'])

      const report = await verifyCertTrust('imap.example.com', 993)
      expect(report.verdict).toBe('inconclusive')
      expect(report.inconclusiveReason).toBe('ca-store-unavailable')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(false)
      // Identity probe only — no verdict probe without a reference set.
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('uses explicit servername for SNI on all probes', async () => {
      mockCa()
      const { capturedOptions } = mockConnectSequence(['ok', 'cert-fail', 'ok'])

      await verifyCertTrust('1.2.3.4', 993, { servername: 'imap.example.com' })
      for (const opts of capturedOptions) {
        expect(opts.servername).toBe('imap.example.com')
        expect(opts.host).toBe('1.2.3.4')
      }
    })

    it('rejects when the identity probe cannot connect', async () => {
      mockConnectSequence(['net-fail'])
      await expect(verifyCertTrust('imap.example.com', 993)).rejects.toThrow('ETIMEDOUT')
    })
  })

  describe('unknownCertTrust', () => {
    it('is an explicitly inconclusive placeholder (never persistable as a verdict)', () => {
      expect(unknownCertTrust()).toEqual({
        fingerprintSha256: '',
        issuerCn: '',
        subjectCn: '',
        systemOnly: false,
        verdict: 'inconclusive',
        conclusive: false,
        evidence: 'partial',
        inconclusiveReason: 'transport-failed',
      })
      expect(unknownCertTrust({ issuerCn: 'Some CA' }).issuerCn).toBe('Some CA')
    })
  })

  // ─── STARTTLS-aware probing (real local server) ────────────────────────────
  //
  // Mail endpoints are not all implicit-TLS. Firing a raw ClientHello into a
  // plaintext IMAP/SMTP port (143/587) yields a protocol error and no
  // certificate at all — the probe would blame the network for a perfectly
  // healthy server, and the interception UX would never fire for STARTTLS
  // accounts.

  describe('verifyCertTrust over STARTTLS', () => {
    let server: net.Server
    let port: number

    /** Minimal IMAP server that speaks the STARTTLS handshake and upgrades. */
    function createImapStartTlsServer(): net.Server {
      const ctx = tls.createSecureContext({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT })
      return net.createServer((socket) => {
        socket.on('error', () => {})
        socket.write('* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n')
        socket.once('data', (chunk: Buffer) => {
          if (!/STARTTLS/i.test(chunk.toString('latin1'))) {
            socket.end('A1 BAD unexpected\r\n')
            return
          }
          socket.write('A1 OK Begin TLS negotiation now\r\n')
          const secured = new tls.TLSSocket(socket, { isServer: true, secureContext: ctx })
          secured.on('error', () => {})
          secured.on('secure', () => { try { secured.write('* OK secured\r\n') } catch { /* ignore */ } })
        })
      })
    }

    beforeEach(async () => {
      __resetCombinedCaCacheForTest()
      server = createImapStartTlsServer()
      server.on('error', () => {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as net.AddressInfo).port
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      __resetCombinedCaCacheForTest()
    })

    it('upgrades a plaintext IMAP port and reads the real certificate identity', async () => {
      const report = await verifyCertTrust('127.0.0.1', port, {
        secure: false,
        protocol: 'imap',
        servername: 'localhost',
      })
      expect(report.fingerprintSha256).toBe(SELF_SIGNED_FP)
      expect(report.subjectCn).toBe('localhost')
      // Self-signed: rejected by the bundled roots AND by the system store.
      expect(report.verdict).toBe('untrusted')
      expect(report.systemOnly).toBe(false)
      expect(report.conclusive).toBe(true)
    })

    it('implicit-TLS probing of the same plaintext port fails (why transport must be carried)', async () => {
      await expect(
        verifyCertTrust('127.0.0.1', port, { secure: true, servername: 'localhost' }),
      ).rejects.toThrow()
    })
  })
})
