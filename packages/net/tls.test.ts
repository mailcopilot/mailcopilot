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
  __testOnly,
} from './tls'
import { isDistrustedRootPem } from './distrustedRoots'

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

// ---------------------------------------------------------------------------
// PRIVATE-CA CHAIN FIXTURE — TEST ONLY.
//
// Reproduces the shape of the incident: a mail host whose leaf is issued by a
// PRIVATE CA with an intermediate, where the server sends leaf + intermediate
// + the self-signed private root in its chain. A pinned LEAF cannot terminate
// such a chain without partial chain building, so before the fix the pinned
// path failed with SELF_SIGNED_CERT_IN_CHAIN and `checkServerIdentity` — i.e.
// the pin comparison — never ran at all.
//
// Static PEMs rather than per-run generation: keygen costs seconds and this
// suite must need neither the openssl binary nor a new dependency. Generated
// with `openssl` (EC P-256, valid until 2126); the private keys exist nowhere
// else and are worthless outside this file. TEST ONLY — never trust anything
// here at runtime.
//
//   PRIVATE_ROOT  CN=MailCopilot Test Private Root CA   (self-signed, CA:TRUE)
//   PRIVATE_SUB   CN=MailCopilot Test Private Sub CA    (signed by root)
//   PRIVATE_LEAF  CN=mail.private.test, SAN DNS + IP:127.0.0.1 (signed by sub)
//   PRIVATE_LEAF2 same issuer and names, different key → different fingerprint
//                 (server-side rotation, or an attacker holding a certificate
//                 from the same private CA)
// ---------------------------------------------------------------------------
const PRIVATE_ROOT_CERT = `-----BEGIN CERTIFICATE-----
MIIBvTCCAWOgAwIBAgIUJ//JutjcCOMIQV3/q1e0PY+O7uUwCgYIKoZIzj0EAwIw
KzEpMCcGA1UEAwwgTWFpbENvcGlsb3QgVGVzdCBQcml2YXRlIFJvb3QgQ0EwIBcN
MjYwOTA5MTEyMTM3WhgPMjEyNjA4MTYxMTIxMzdaMCsxKTAnBgNVBAMMIE1haWxD
b3BpbG90IFRlc3QgUHJpdmF0ZSBSb290IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAElrLugrKCLHNpVbCKZKE1HtX0yGdw2ry/lxgkgQpHDv+gMzsHDGU0mD2u
NLsdipGrEm8wOrGerNuc5nENrXUqmqNjMGEwHQYDVR0OBBYEFGRCkS5AeoI6VlTw
P+Es7I+qUX69MB8GA1UdIwQYMBaAFGRCkS5AeoI6VlTwP+Es7I+qUX69MA8GA1Ud
EwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQDq
NEDuDzuNwUVw0JrjPgunbZohHgLYS85Q0EWA+CnjsQIgYulgGzN+BkTXczFZrrw7
pjhzr4nH5jTMF6hobRGX/Zc=
-----END CERTIFICATE-----
`

const PRIVATE_SUB_CERT = `-----BEGIN CERTIFICATE-----
MIIBvzCCAWWgAwIBAgIUGUJEvgHweP8EfCM4ROauh/1nf20wCgYIKoZIzj0EAwIw
KzEpMCcGA1UEAwwgTWFpbENvcGlsb3QgVGVzdCBQcml2YXRlIFJvb3QgQ0EwIBcN
MjYwOTA5MTEyMTM3WhgPMjEyNjA4MTYxMTIxMzdaMCoxKDAmBgNVBAMMH01haWxD
b3BpbG90IFRlc3QgUHJpdmF0ZSBTdWIgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAARYiamEU2uABxoNSRpBQwYKbuPkja1vxt3gDwk92BWz77EjkkdswhiP7hMg
MI5TJ5qT28Eg9AGElAfg5U0ougdRo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMA4G
A1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUos+vkNJnuVd7ntjRAqMDUHGfVcEwHwYD
VR0jBBgwFoAUZEKRLkB6gjpWVPA/4Szsj6pRfr0wCgYIKoZIzj0EAwIDSAAwRQIg
fpscEQhqgTLpDkV1+4dEHS3caIaRrQFjAfpolVZd4/ACIQDG90N8Vn6vmRlRFZI7
Rj0/J9oEgHLZ6OREbUASA8clAg==
-----END CERTIFICATE-----
`

const PRIVATE_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIB5TCCAYugAwIBAgIUExOXnh1RBY5OZSeenigMIGyLL6QwCgYIKoZIzj0EAwIw
KjEoMCYGA1UEAwwfTWFpbENvcGlsb3QgVGVzdCBQcml2YXRlIFN1YiBDQTAgFw0y
NjA5MDkxMTIxMzdaGA8yMTI2MDgxNjExMjEzN1owHDEaMBgGA1UEAwwRbWFpbC5w
cml2YXRlLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATgiyNku4T3Zym3
aqOBd/vtFxTwmI9YGgbWkPTIayE5jqe7y82PxUZylG7uWNdR9YqltpIOKvUdXBVR
8ZTGD9UMo4GaMIGXMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1Ud
JQQMMAoGCCsGAQUFBwMBMCIGA1UdEQQbMBmCEW1haWwucHJpdmF0ZS50ZXN0hwR/
AAABMB0GA1UdDgQWBBT5CXYbtw/+zoHheQAIhHHY1fr3ITAfBgNVHSMEGDAWgBSi
z6+Q0me5V3ue2NECowNQcZ9VwTAKBggqhkjOPQQDAgNIADBFAiBX/+jKWQ0Mtuer
UjS46Dcgu/oHSEVKmXuEaqJQ0OLHhgIhAJGAWl1MR3Up6hfz5elxNoCI4ChuYJbN
xkfSO0ZOU8MN
-----END CERTIFICATE-----
`

const PRIVATE_LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgeeMrc3wmgs4dX/+8
UMjQtQSIwzpjg/PVCjrktyLQqSehRANCAATgiyNku4T3Zym3aqOBd/vtFxTwmI9Y
GgbWkPTIayE5jqe7y82PxUZylG7uWNdR9YqltpIOKvUdXBVR8ZTGD9UM
-----END PRIVATE KEY-----
`

const PRIVATE_LEAF2_CERT = `-----BEGIN CERTIFICATE-----
MIIB5TCCAYugAwIBAgIUExOXnh1RBY5OZSeenigMIGyLL6UwCgYIKoZIzj0EAwIw
KjEoMCYGA1UEAwwfTWFpbENvcGlsb3QgVGVzdCBQcml2YXRlIFN1YiBDQTAgFw0y
NjA5MDkxMTIxMzdaGA8yMTI2MDgxNjExMjEzN1owHDEaMBgGA1UEAwwRbWFpbC5w
cml2YXRlLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASiu2JFNdt0kX+u
bewBMicTEm1kPZ8cUTMzBBiARGUEfdK40yYZ6/i81IeMNc86UL22RqaoBhPwpbUP
7o3BixZQo4GaMIGXMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1Ud
JQQMMAoGCCsGAQUFBwMBMCIGA1UdEQQbMBmCEW1haWwucHJpdmF0ZS50ZXN0hwR/
AAABMB0GA1UdDgQWBBTlYiefB8BsxRVCKES/jWXtjDWHoDAfBgNVHSMEGDAWgBSi
z6+Q0me5V3ue2NECowNQcZ9VwTAKBggqhkjOPQQDAgNIADBFAiEAsClsSPtqV7vF
D6Nbg3ELH1E1YcY+zORximhocjqSaAACIEna8VqBZrzGT0IF8nZqvWks+yfxQgW7
s0A7FTh8/jlN
-----END CERTIFICATE-----
`

const PRIVATE_LEAF2_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgygibbUl0CnD94Oi9
a+TR11UiIa/Y8DU4Cf7OuSM7WzqhRANCAASiu2JFNdt0kX+ubewBMicTEm1kPZ8c
UTMzBBiARGUEfdK40yYZ6/i81IeMNc86UL22RqaoBhPwpbUP7o3BixZQ
-----END PRIVATE KEY-----
`

/** The Sub CA's own fingerprint — used where the CONFIRMED anchor is itself a
 *  CA (`basicConstraints: CA:TRUE`), the shape that retired the trust-list
 *  containment: such an anchor terminates the chain of every certificate it
 *  ever issued, and no filtering of the store can reach it. */
const PRIVATE_SUB_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(PRIVATE_SUB_CERT).fingerprint256,
)

const PRIVATE_LEAF_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(PRIVATE_LEAF_CERT).fingerprint256,
)
const PRIVATE_LEAF2_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(PRIVATE_LEAF2_CERT).fingerprint256,
)

// ---------------------------------------------------------------------------
// Local-server lifecycle helpers.
//
// Teardown here has to hold on the FAILURE paths, not only the happy one: a
// suite that hangs in `afterEach` reports a timeout on an unrelated test and
// leaves a listening socket behind for the rest of the run.
//
// Two hazards, both closed below:
//  - `server.close()` waits for every open connection to end. A peer socket
//    that outlives its test — a rejected handshake, an assertion that threw
//    before the client helper returned — keeps the callback pending forever.
//    So connections are TRACKED and destroyed before closing.
//  - `listen` resolves only when the bind succeeds. With the customary
//    `server.on('error', () => {})` swallowing the failure, a bind error left
//    the promise pending until the test timeout, with no message. So binding
//    gets its own error listener that REJECTS.
// ---------------------------------------------------------------------------

type TrackedServer = { destroyConnections: () => void }
const trackedServers = new WeakMap<net.Server, TrackedServer>()

/** Bind on an ephemeral loopback port; rejects (rather than hanging) on error.
 *  Also starts tracking peer sockets for `closeServer`. */
function listenLocal(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  trackedServers.set(server, {
    destroyConnections: () => {
      for (const socket of sockets) {
        try { socket.destroy() } catch { /* already gone */ }
      }
      sockets.clear()
    },
  })
  return new Promise<number>((resolve, reject) => {
    const onError = (e: Error) => reject(e)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

/** Destroy any lingering peer sockets, then close. Safe on an unbound or
 *  already-closed server. */
async function closeServer(server: net.Server | undefined): Promise<void> {
  if (!server) return
  trackedServers.get(server)?.destroyConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

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

    it('classifies the anchored-endpoint hold as a trust error, so the IMAP recovery dialog opens', () => {
      // Load-bearing, not cosmetic: the hold is the named PRICE of design B —
      // on an endpoint holding a confirmed certificate body, a pin that has
      // only a fingerprint stops working. Its only remedy is confirming that
      // certificate too, and the recovery dialog is raised by the 'cert'
      // classification (classifyImapError → isTlsTrustError). Misclassify this
      // message as a network error and the price becomes a dead end.
      const hold = new Error(
        'TLS pin not confirmed: AA:BB — this endpoint accepts only certificates confirmed in the recovery dialog',
      )
      expect(isTlsTrustError(hold)).toBe(true)
      // Also when a transport library prefixes its own text, as ImapFlow does.
      expect(isTlsTrustError(new Error('LOGIN aborted: TLS pin not confirmed: AA:BB'))).toBe(true)
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

    it('caches within the TTL and recomputes OUR snapshot after it expires', () => {
      vi.useFakeTimers()
      const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      expect(getCombinedCaCertificates()).toEqual(['D', 'S'])
      expect(getCombinedCaCertificates()).toEqual(['D', 'S'])
      expect(spy).toHaveBeenCalledTimes(2) // default + system, once each

      // What is pinned here is OUR cache: after the TTL the snapshot is
      // RECOMPUTED from the source rather than reused.
      //
      // It is NOT a claim that an OS-store change is picked up. On the real
      // runtime `tls.getCACertificates` hands back a frozen per-process
      // snapshot (see the CA_CACHE_TTL_MS docblock), so a root the
      // administrator removes mid-session keeps its effect until the
      // application restarts. Only the stub below can change its answer.
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

    it('real Node runtime: combined set is a superset of the default set minus the distrusted roots', () => {
      // No mocks — sanity-check the actual runtime (Node >= 22.15 in dev/CI).
      // Skip silently on runtimes without the API (fallback covered above).
      const getCa = (tls as { getCACertificates?: (t?: string) => string[] }).getCACertificates
      if (typeof getCa !== 'function') return
      const combined = getCombinedCaCertificates()
      expect(combined).not.toBeNull()
      const have = new Set(combined!.map((p) => p.trim()))
      // Node security releases dropped the eMudhra roots from the bundled
      // store, but a runtime one step older still ships "emSign ECC Root
      // CA - G3" (measured: Node v22.22.1 carries it). On such a Node the
      // combined list is NOT a plain superset of the default set — the
      // distrusted-roots filter removes that root BY DESIGN. So the superset
      // is asserted only over the default roots that survive the filter,
      // and for the rest the removal itself is pinned: whichever side of the
      // bundle bump the runtime is on, a distrusted root must never be in
      // the list we hand to OpenSSL.
      for (const pem of getCa('default')) {
        if (isDistrustedRootPem(pem)) {
          expect(have.has(pem.trim())).toBe(false)
        } else {
          expect(have.has(pem.trim())).toBe(true)
        }
      }
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
     * strings ('D', 'S') for the snapshot that real OpenSSL would reject as
     * PEM. Anchors, by contrast, must be real certificate bodies here — only
     * parsed bodies reach the trust list at all (see `buildTlsOptions`).
     */
    type ContextOpts = { ca?: string | string[]; allowPartialTrustChain?: boolean }
    let caPassedToContext: () => string[] | undefined
    let optsPassedToContext: () => ContextOpts | undefined
    let contextCalls: () => number

    beforeEach(() => {
      __resetCombinedCaCacheForTest()
      const seen: ContextOpts[] = []
      vi.spyOn(tls, 'createSecureContext').mockImplementation(((opts?: ContextOpts) => {
        seen.push(opts ?? {})
        return { __stub: true } as unknown as tls.SecureContext
      }) as typeof tls.createSecureContext)
      const caOf = (opts?: ContextOpts) =>
        typeof opts?.ca === 'string' ? [opts.ca] : (opts?.ca as string[] | undefined)
      caPassedToContext = () => caOf(seen[seen.length - 1])
      optsPassedToContext = () => seen[seen.length - 1]
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

      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })
      // The anchor is APPENDED to the snapshot; the snapshot itself is handed
      // over untouched. (An earlier revision reduced it to its self-signed
      // subset under the partial-chain flag; that filter is gone — containment
      // moved into `checkServerIdentity`, see the hold tests below.)
      expect(caPassedToContext()).toEqual(['D', 'S', SELF_SIGNED_CERT])
      expect(opts!.rejectUnauthorized).toBe(true)
    })

    it('with pins and no CA API — trust narrows to the pinned anchors only', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })
      expect(caPassedToContext()).toEqual([SELF_SIGNED_CERT])
      expect(opts!.rejectUnauthorized).toBe(true)
    })

    it('with pins, anchor PEM, and NO CA API — partial chain still turns on, the pin is the only guard left', () => {
      // A parsed anchor is the sole switch for the flag — it does not
      // check whether `combined` exists. Uncovered gap: `combined === null`
      // was only asserted for the resulting `ca` array (see the test above),
      // never for `allowPartialTrustChain` or for what still enforces
      // identity once the system trust store is gone entirely.
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'localhost',
      })!
      expect(caPassedToContext()).toEqual([SELF_SIGNED_CERT])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)
      expect(opts.rejectUnauthorized).toBe(true)

      // Wrong fingerprint — refused. Nothing else in the trust set could
      // have stopped this connection; the pin comparison is doing all the
      // work that the (absent) system store normally shares with it.
      const wrong = { fingerprint256: '00:11', subjectaltname: 'DNS:localhost' } as unknown as tls.PeerCertificate
      const err = opts.checkServerIdentity!('localhost', wrong)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('TLS pin mismatch')

      // Matching, anchored fingerprint — accepted, hostname not consulted.
      const right = {
        fingerprint256: SELF_SIGNED_FP,
        subjectaltname: 'DNS:something-else.test',
      } as unknown as tls.PeerCertificate
      expect(opts.checkServerIdentity!('localhost', right)).toBeUndefined()
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

    // ─── partial chain building (private-CA pinned servers) ────────────────
    //
    // A pinned LEAF can only terminate a chain under OpenSSL's
    // X509_V_FLAG_PARTIAL_CHAIN (Node: `allowPartialTrustChain`). The real
    // handshakes that prove what that means are further down; these assert
    // WHICH context each path asks for.

    it('pinned path WITH anchors asks for partial chain building', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] })
      expect(caPassedToContext()).toEqual(['D', 'S', SELF_SIGNED_CERT])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)
    })

    it('unpinned path asks for EXACTLY `{ ca }` — nothing about chain building changes there', () => {
      // The widening the flag performs is list-wide: every intermediate in the
      // trust store becomes a standalone end of trust. On the pinned path the
      // fingerprint check contains that; here there is nothing to contain it,
      // so the option object must stay byte-for-byte what it always was.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      buildTlsOptions({})
      expect(Object.keys(optsPassedToContext() ?? {})).toEqual(['ca'])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()
    })

    it('pinned path WITHOUT anchors asks for full chain building', () => {
      // Nothing of ours could terminate a chain here, so the flag would only
      // promote the general trust store's intermediates for no benefit at all.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      buildTlsOptions({ tlsPinsSha256: ['AA:BB'] })
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()
    })

    it('whitespace-only and empty pinned cert PEM entries never turn partial chain building on', () => {
      // Two garbage rows ('   ', '') must not be mistaken for anchors. They
      // are dropped by the `Boolean(pem && pem.trim())` filter, and — since
      // the flag is derived from the PARSED anchor set — they could not have
      // turned it on even if they had survived.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const opts = buildTlsOptions({
        tlsPinsSha256: ['AA:BB'],
        tlsPinnedCertsPem: ['   ', ''],
      })!
      expect(caPassedToContext()).toEqual(['D', 'S'])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()
      expect(opts.rejectUnauthorized).toBe(true)
    })

    it('a stored anchor that is not a parsable certificate does NOT turn partial chain building on', () => {
      // The flag is derived from `anchorFingerprints`, not from the raw stored
      // list, so the set that decides "is the presented leaf an anchor?" IS the
      // set that switched the flag on. A corrupt row (non-empty, but not a
      // certificate) therefore relaxes nothing — and it does not reach `ca`
      // either: only parsed bodies travel on, so the endpoint keeps ordinary
      // chain building and the ordinary hostname check over a trust list that
      // is exactly the snapshot.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const corrupt = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'
      buildTlsOptions({ tlsPinsSha256: ['AA:BB'], tlsPinnedCertsPem: [corrupt] })
      expect(caPassedToContext()).toEqual(['D', 'S'])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()
    })

    it('a real anchor survives filtering alongside whitespace/empty noise — flag turns on, the noise never reaches `ca`', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT, '   ', ''],
      })
      expect(caPassedToContext()).toEqual(['D', 'S', SELF_SIGNED_CERT])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)
    })

    it('a corrupt anchor entry BEFORE a real one does not stop the loop from finding the real one', () => {
      // Every earlier test with a corrupt entry used it ALONE or alongside
      // whitespace/empty noise (which never reaches the try/catch at all — it
      // is filtered out before the loop runs). None of them exercises what
      // happens when `new X509Certificate(pem)` actually THROWS for an entry
      // that precedes a real one: a `for...of` that breaks or returns on the
      // first caught exception (a plausible "simplify the loop" mutation)
      // would silently disable partial-chain building for every endpoint
      // whose corrupt row happens to sort before its real one.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const corrupt = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [corrupt, SELF_SIGNED_CERT],
      })!
      // The corrupt entry is dropped from the trust list, the real one is not.
      expect(caPassedToContext()).toEqual(['D', 'S', SELF_SIGNED_CERT])
      expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)

      // Behavioural proof, not just the flag: the real anchor still grants
      // identity despite sorting after the corrupt one.
      const right = {
        fingerprint256: SELF_SIGNED_FP,
        subjectaltname: 'DNS:something-else.test',
      } as unknown as tls.PeerCertificate
      expect(opts.checkServerIdentity!('localhost', right)).toBeUndefined()
    })

    it('a partial-chain context is never handed to an unpinned connection', () => {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const pinned = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })!
      const plain = buildTlsOptions({})!
      expect(contextCalls()).toBe(2)
      expect(plain.secureContext).not.toBe(pinned.secureContext)
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()
    })

    it('the SecureContext cache key names the partial-chain flag', () => {
      // SECURITY-LOAD-BEARING, and deliberately tested on the key function
      // itself rather than through buildTlsOptions: today the flag is only
      // ever requested together with a non-empty anchor set, whose key
      // part already separates the entries, so no call site can currently produce
      // the collision. That is a coincidence of the call sites, not a property
      // of the cache. If the flag is left out of the key, a later change that
      // asks for it on an anchor set some other endpoint uses WITHOUT it would
      // silently hand that endpoint a relaxed context. The old key —
      // `${revision}|${anchorsKey(anchors)}` — fails this test.
      const { secureContextCacheKey } = __testOnly
      expect(secureContextCacheKey(1, [], true)).not.toBe(secureContextCacheKey(1, [], false))
      expect(secureContextCacheKey(1, ['ANCHOR-A'], true)).not.toBe(
        secureContextCacheKey(1, ['ANCHOR-A'], false),
      )
      // The two inputs the key already named must keep separating entries.
      expect(secureContextCacheKey(1, [], false)).not.toBe(secureContextCacheKey(2, [], false))
      expect(secureContextCacheKey(1, ['ANCHOR-A'], true)).not.toBe(
        secureContextCacheKey(1, ['ANCHOR-B'], true),
      )
      // Same inputs → same key, or the cache would never hit.
      expect(secureContextCacheKey(1, ['ANCHOR-A'], true)).toBe(
        secureContextCacheKey(1, ['ANCHOR-A'], true),
      )
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

    it('a CA snapshot refresh rebuilds the context — our two caches change over together', () => {
      vi.useFakeTimers()
      try {
        const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
          return type === 'default' ? ['D'] : ['S']
        }) as typeof tls.getCACertificates)

        const before = buildTlsOptions({})!
        expect(contextCalls()).toBe(1)

        // The snapshot's CONTENTS change (here by stubbing the source). What
        // is pinned is OUR plumbing: a recomputed snapshot must orphan every
        // context built from the previous contents, so the `ca` arrays and the
        // OpenSSL contexts never disagree about what is trusted.
        //
        // Note what this does NOT claim. On the real runtime the source is a
        // frozen per-process snapshot (see the CA_CACHE_TTL_MS docblock), so a
        // root the admin removes mid-session stays trusted until restart. That
        // is Node's behaviour, not ours, and the test stays off it deliberately.
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

      // Real certificate bodies, not sentinels: only PARSED bodies reach the
      // trust list, so a sentinel string would be filtered out and both
      // endpoints would collapse onto the shared no-anchor context.
      const a = buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] })!
      expect(caPassedToContext()).toEqual(['D', 'S', SELF_SIGNED_CERT])
      const b = buildTlsOptions({ tlsPinsSha256: [DNS_ONLY_FP], tlsPinnedCertsPem: [DNS_ONLY_CERT] })!
      expect(caPassedToContext()).toEqual(['D', 'S', DNS_ONLY_CERT])
      expect(a.secureContext).not.toBe(b.secureContext)
      // An unpinned endpoint must not receive either anchored context.
      const plain = buildTlsOptions({})!
      expect(plain.secureContext).not.toBe(a.secureContext)
      expect(plain.secureContext).not.toBe(b.secureContext)
      // Same anchors again → the cached context, not a fourth build.
      const callsBefore = contextCalls()
      expect(
        buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] })!.secureContext,
      ).toBe(a.secureContext)
      expect(contextCalls()).toBe(callsBefore)
    })

    it('a FINGERPRINT-ONLY pinned endpoint shares ONE context with the plain unpinned endpoint — sharing is safe because identity narrows per-connection, not per-context', () => {
      // With no anchor PEM, the pinned path's `ca` and `partialChain` inputs
      // are byte-for-byte what the unpinned path already builds
      // (`anchors: []`, flag off) — the three-part key collapses to the same
      // value. That is not a leak: `checkServerIdentity` and
      // `rejectUnauthorized` stay per-connection, so sharing the underlying
      // OpenSSL trust store buys nothing to an attacker and one fewer
      // `createSecureContext` call to the hot path.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const unpinned = buildTlsOptions({})!
      const fingerprintOnly = buildTlsOptions({ tlsPinsSha256: ['AA:BB'] })!
      expect(contextCalls()).toBe(1)
      expect(fingerprintOnly.secureContext).toBe(unpinned.secureContext)
      expect(unpinned.checkServerIdentity).toBeUndefined()
      expect(fingerprintOnly.checkServerIdentity).toBeInstanceOf(Function)
    })

    it('adding a stored certificate PEM to a previously fingerprint-only pin crosses the anchors boundary into a FRESH, partial-chain context', () => {
      // The account's pin did not change, only whether its body is known —
      // but that alone must move it off the shared no-anchor context above
      // and onto a distinct, partial-chain one (anchorsKey changes AND the
      // flag flips).
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const fingerprintOnly = buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP] })!
      expect(optsPassedToContext()?.allowPartialTrustChain).toBeUndefined()

      const anchored = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })!
      expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)
      expect(anchored.secureContext).not.toBe(fingerprintOnly.secureContext)
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
      // anchorsKey() joins with a NUL separator between PEM bodies precisely
      // so that ['AB', 'C'] and ['A', 'BC'] cannot produce the same key.
      // Without it, an endpoint would hit the cache entry built for a
      // DIFFERENT anchor set and silently reuse the wrong trust store.
      //
      // Asserted on the key function rather than through `buildTlsOptions`,
      // for the same reason as the partial-chain key test above: only PARSED
      // certificate bodies reach the key now, and no pair of real
      // certificates can express this split — the property belongs to the
      // key construction, not to any call site.
      const { secureContextCacheKey } = __testOnly
      expect(secureContextCacheKey(1, ['AB', 'C'], true)).not.toBe(
        secureContextCacheKey(1, ['A', 'BC'], true),
      )
    })

    it('a revision bump sweeps ALL stale-revision entries out of the cache, not just the one being looked up', () => {
      // §2.156: without this sweep the cache would grow by (accounts ×
      // revisions) for the whole process lifetime — a RECOMPUTED snapshot
      // orphans every context built from the previous contents, and nothing
      // else ever removes them. (Recomputed, not refreshed: the source is
      // frozen per process — see the CA_CACHE_TTL_MS docblock.)
      vi.useFakeTimers()
      try {
        const spyCa = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
          return type === 'default' ? ['D'] : ['S']
        }) as typeof tls.getCACertificates)

        // Three distinct trust sets built in revision 1: two pinned accounts
        // plus the plain unpinned one.
        buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] })
        buildTlsOptions({ tlsPinsSha256: [DNS_ONLY_FP], tlsPinnedCertsPem: [DNS_ONLY_CERT] })
        buildTlsOptions({})
        expect(contextCalls()).toBe(3)

        // The stub changes its answer and the TTL expires, so the snapshot is
        // recomputed and the revision bumps. Modelling only our own plumbing —
        // the real store cannot change mid-process.
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

    it('a revision bump orphans BOTH the full (unpinned) and the partial-chain (anchored) context', () => {
      // The sweep test above proves stale entries get DELETED; it never
      // rebuilds the partial-chain variant afterwards, so it cannot show
      // whether that variant's NEXT lookup actually gets a fresh context
      // rather than an accidental hit against a leftover key. The three-part
      // key names the revision for both variants alike — verify both really
      // rebuild, not just that the map shrank.
      vi.useFakeTimers()
      try {
        const spy = vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
          return type === 'default' ? ['D'] : ['S']
        }) as typeof tls.getCACertificates)

        const anchored = { tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] }
        const fullBefore = buildTlsOptions({})!
        const partialBefore = buildTlsOptions(anchored)!
        expect(contextCalls()).toBe(2)

        spy.mockImplementation(((type?: string) =>
          (type === 'default' ? ['D2'] : ['S'])) as typeof tls.getCACertificates)
        vi.advanceTimersByTime(CA_CACHE_TTL_MS + 1)

        const fullAfter = buildTlsOptions({})!
        const partialAfter = buildTlsOptions(anchored)!

        expect(fullAfter.secureContext).not.toBe(fullBefore.secureContext)
        expect(partialAfter.secureContext).not.toBe(partialBefore.secureContext)
        // The last build was the partial-chain one — it still asks for partial
        // chain building, and its list is the REFRESHED snapshot plus the
        // anchor.
        expect(caPassedToContext()).toEqual(['D2', 'S', SELF_SIGNED_CERT])
        expect(optsPassedToContext()?.allowPartialTrustChain).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a same-revision cache miss for one flag variant does not evict a live entry of the OTHER variant', () => {
      // The sweep loop in `secureContextFor` deletes purely on
      // `v.revision !== revision`. Building a NEW key (different anchors, or
      // a different partial-chain flag) at the SAME revision must not sweep
      // away an entry that already belongs to that same revision, no matter
      // which flag variant it is.
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) => {
        return type === 'default' ? ['D'] : ['S']
      }) as typeof tls.getCACertificates)

      const full = buildTlsOptions({})!
      expect(contextCalls()).toBe(1)

      // Cache miss on a DIFFERENT key (partial-chain, different anchors),
      // same revision — this is exactly the branch that runs the sweep loop.
      buildTlsOptions({ tlsPinsSha256: [SELF_SIGNED_FP], tlsPinnedCertsPem: [SELF_SIGNED_CERT] })
      expect(contextCalls()).toBe(2)

      const fullAgain = buildTlsOptions({})!
      expect(contextCalls()).toBe(2) // no third build — the full entry survived
      expect(fullAgain.secureContext).toBe(full.secureContext)
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

      // Behavioural proof, not just reference inequality: the two endpoints
      // refuse B's extra renderer pin for DIFFERENT reasons, and the reason is
      // exactly what each endpoint knows. B knows the pin, so its refusal is
      // the anchored-endpoint hold ("the body was never confirmed")...
      const rendererCert = {
        fingerprint256: rendererPinB,
        subjectaltname: 'DNS:account-b.example.com',
      } as unknown as tls.PeerCertificate
      const errB = b.checkServerIdentity!('1.2.3.4', rendererCert)
      expect(errB).toBeInstanceOf(Error)
      expect(errB!.message).toContain('TLS pin not confirmed')
      // ...while A never learned that pin at all, so it stops one step earlier
      // with a mismatch. Sharing the SecureContext did not smuggle the pin
      // across.
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
      //
      // Such an endpoint runs a PARTIAL-CHAIN context (it has a parsed
      // anchor), and there the hostname check is no longer enough to keep a
      // renderer-written pin a narrowing of trust — so the fingerprint-only
      // leaf is refused outright, one step BEFORE the name is looked at.
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

      // Fingerprint-only leaf on the SAME endpoint → refused as unconfirmed.
      const fingerprintOnly = {
        fingerprint256: rendererPin,
        subjectaltname: 'DNS:attacker.example.com',
      } as unknown as tls.PeerCertificate
      const err = opts!.checkServerIdentity!('1.2.3.4', fingerprintOnly)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('TLS pin not confirmed')
      expect(err!.message).toContain(rendererPin)
      // WHO refused: the hold, not the name check. A message mentioning
      // altnames/subject would mean the leaf reached `tls.checkServerIdentity`
      // — i.e. it was being judged by its name on a partial-chain context.
      expect(err!.message).not.toMatch(/altnames|subject/i)
      // And it is a TRUST error, so the recovery dialog opens and the user can
      // confirm this certificate too (the named remedy for the named price).
      expect(isTlsTrustError(err)).toBe(true)

      // A fingerprint-only leaf that names the DIALLED host is refused just the
      // same: on this endpoint the name buys nothing.
      const matching = {
        fingerprint256: rendererPin,
        subjectaltname: 'DNS:smtp.gmail.com',
      } as unknown as tls.PeerCertificate
      expect(opts!.checkServerIdentity!('1.2.3.4', matching)!.message).toContain(
        'TLS pin not confirmed',
      )
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
      // Rejected handshakes surface here; swallow so they don't crash the run.
      // Bind failures do NOT go through here — `listenLocal` rejects on those.
      server.on('tlsClientError', () => {})
      port = await listenLocal(server)
    })

    afterEach(async () => {
      await closeServer(server)
      __resetCombinedCaCacheForTest()
    })

    /** Attempt a handshake with the given options; never throws. */
    function handshake(opts: tls.ConnectionOptions): Promise<{ ok: boolean; error?: Error }> {
      return new Promise((resolve) => {
        let settled = false
        const done = (r: { ok: boolean; error?: Error }) => {
          if (settled) return
          settled = true
          // Closing the client in `finally`: teardown must not depend on the
          // destroy call succeeding, and `server.close()` in afterEach cannot
          // complete while this peer is still open.
          try { socket.destroy() } catch { /* already gone */ } finally { resolve(r) }
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

    it('a corrupt stored body next to a real anchor → options still build on the REAL context, and the real anchor still grants identity', async () => {
      // Every other corrupt-anchor test stubs `tls.createSecureContext`, so
      // none of them can say what OpenSSL does with such a row. That mattered:
      // the production comment used to ASSUME a garbage entry in `ca` is
      // ignored, and if `createSecureContext` rejected it instead,
      // `buildTlsOptions` would throw before any socket — every connection for
      // the account failing with an error that does not classify as a trust
      // error, so network-class backoff and no recovery dialog. This describe
      // block uses the real constructor, and the code now hands it only parsed
      // bodies, which makes the question moot rather than answered by luck.
      const corrupt = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [corrupt, SELF_SIGNED_CERT],
        // A name the certificate does not carry: only the ANCHORED identity
        // mode can accept this, so the handshake succeeding proves the real
        // anchor survived alongside the corrupt row — flag, trust list and all.
        servername: 'not-the-pinned-host.example',
      })!
      expect(opts.rejectUnauthorized).toBe(true)
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('a corrupt stored body ALONE → no anchor, so the self-signed server still fails CLOSED', async () => {
      // The other half of the narrowing: dropping the row must not accidentally
      // leave the endpoint anchored by something unparsable.
      const corrupt = '-----BEGIN CERTIFICATE-----\nnot-a-certificate\n-----END CERTIFICATE-----\n'
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [corrupt],
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
      port = await listenLocal(server)
    })

    afterEach(async () => {
      await closeServer(server)
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
          // Closing the client in `finally`: teardown must not depend on the
          // destroy call succeeding, and `server.close()` in afterEach cannot
          // complete while this peer is still open.
          try { socket.destroy() } catch { /* already gone */ } finally { resolve(r) }
        }
        const socket = tls.connect({ host: '127.0.0.1', port, ...opts }, () => done({ ok: true }))
        socket.once('error', (e: Error) => done({ ok: false, error: e }))
        socket.setTimeout(5_000, () => done({ ok: false, error: new Error('handshake timeout') }))
      })
    }

    /**
     * Same dial, while recording whether Node reached the PINNED
     * `checkServerIdentity`.
     *
     * That observable is what names the layer that refused: Node invokes the
     * callback only after OpenSSL verified the chain, so `identityChecked ===
     * false` means the chain was refused and no pin could have mattered, while
     * `true` means the chain verified and OUR identity layer is what stopped
     * the connection. Asserting an error code alone cannot tell the two apart.
     */
    async function handshakeByIpTracked(
      opts: tls.ConnectionOptions,
    ): Promise<{ ok: boolean; error?: Error; identityChecked: boolean }> {
      const inner = opts.checkServerIdentity
      if (!inner) throw new Error('handshakeByIpTracked needs the pinned identity callback')
      let identityChecked = false
      const r = await handshakeByIp({
        ...opts,
        checkServerIdentity: (host, cert) => {
          identityChecked = true
          return inner(host, cert)
        },
      })
      return { ...r, identityChecked }
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
      // on the same endpoint. The server presents the fingerprint-only one,
      // handed to OpenSSL as a root so the CHAIN cannot be what refuses it —
      // that is what makes the refusal attributable to the identity layer.
      const opts = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP, DNS_ONLY_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
      })!
      const r = await handshakeByIpTracked(
        withTrust(opts, [...(getCombinedCaCertificates() ?? []), SELF_SIGNED_CERT, DNS_ONLY_CERT]),
      )
      expect(r.ok).toBe(false)
      // The chain verified, so the pin callback ran — and it refused, because
      // this endpoint holds a confirmed BODY and this leaf is not one.
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin not confirmed')
      expect(r.error?.message).toContain(DNS_ONLY_FP)
      // Not the name check (the leaf names domains, the dial is a bare IP, so
      // that check would also have failed — it simply never runs here) and not
      // an OpenSSL chain verdict: our refusals carry no `code`.
      expect(r.error?.message).not.toMatch(/altnames|subject/i)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined()
      expect(isTlsTrustError(r.error)).toBe(true)
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

  // ─── PRIVATE-CA SERVER — partial chain building ────────────────────────────
  //
  // The incident this exists for: a mail host moved from a public CA to a
  // PRIVATE one and now serves leaf → Sub CA → self-signed private root,
  // sending all three. "Trust this certificate" stored a correct pin and the
  // very next connection failed identically — forever — because a pinned LEAF
  // cannot be a trust anchor unless partial chain building is on, so the chain
  // never verified, so Node never called `checkServerIdentity`, so the pin was
  // never even compared.
  //
  // Fully hermetic: a local server with a generated private chain, no network.

  describe('private-CA server (leaf → Sub CA → self-signed private root)', () => {
    let server: tls.Server | undefined
    let port = 0

    /** Serve `leafCert` and send the WHOLE chain, private root included —
     *  the shape the affected server actually presents. */
    async function serve(leafCert: string, leafKey: string): Promise<void> {
      server = tls.createServer(
        { key: leafKey, cert: leafCert + PRIVATE_SUB_CERT + PRIVATE_ROOT_CERT },
        (socket) => socket.end('OK\r\n'),
      )
      server.on('tlsClientError', () => {})
      port = await listenLocal(server)
    }

    beforeEach(() => {
      __resetCombinedCaCacheForTest()
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      await closeServer(server)
      server = undefined
      __resetCombinedCaCacheForTest()
    })

    /** Pretend the OS store contains `certs` (and nothing else public), so a
     *  test can model a machine that has the private CA installed. */
    function osStoreContains(certs: string[]): void {
      vi.spyOn(tls, 'getCACertificates').mockImplementation(((type?: string) =>
        type === 'default' ? certs : []) as typeof tls.getCACertificates)
    }

    type Attempt = { ok: boolean; error?: Error; identityChecked: boolean }

    /** Handshake with an explicitly built context. Reports whether Node
     *  reached `checkServerIdentity` — the observable that distinguishes
     *  "chain verified, pin compared" from "chain failed, pin ignored". */
    function rawHandshake(ctxOpts: tls.SecureContextOptions): Promise<Attempt> {
      return new Promise((resolve) => {
        let settled = false
        let identityChecked = false
        const done = (r: Omit<Attempt, 'identityChecked'>) => {
          if (settled) return
          settled = true
          try { socket.destroy() } catch { /* already gone */ } finally { resolve({ ...r, identityChecked }) }
        }
        const socket = tls.connect(
          {
            host: '127.0.0.1',
            port,
            servername: 'mail.private.test',
            rejectUnauthorized: true,
            secureContext: tls.createSecureContext(ctxOpts),
            checkServerIdentity: () => {
              identityChecked = true
              return undefined
            },
          },
          () => done({ ok: true }),
        )
        socket.once('error', (e: Error) => done({ ok: false, error: e }))
        socket.setTimeout(5_000, () => done({ ok: false, error: new Error('handshake timeout') }))
      })
    }

    /** Handshake with options exactly as `buildTlsOptions` produced them. */
    function handshake(opts: tls.ConnectionOptions): Promise<{ ok: boolean; error?: Error }> {
      return new Promise((resolve) => {
        let settled = false
        const done = (r: { ok: boolean; error?: Error }) => {
          if (settled) return
          settled = true
          // Closing the client in `finally`: teardown must not depend on the
          // destroy call succeeding, and `server.close()` in afterEach cannot
          // complete while this peer is still open.
          try { socket.destroy() } catch { /* already gone */ } finally { resolve(r) }
        }
        const socket = tls.connect({ host: '127.0.0.1', port, ...opts }, () => done({ ok: true }))
        socket.once('error', (e: Error) => done({ ok: false, error: e }))
        socket.setTimeout(5_000, () => done({ ok: false, error: new Error('handshake timeout') }))
      })
    }

    /**
     * Same, while recording whether Node reached the PINNED
     * `checkServerIdentity` — the observable that names WHO refused.
     *
     * Node invokes the callback only on the branch where chain verification
     * already succeeded, so `identityChecked === false` means OpenSSL refused
     * the chain and no pin could have changed the outcome, while `true` means
     * the chain verified and our per-certificate hold is what stopped the
     * connection. Design B places containment in the second layer, so every
     * assertion about it has to say which layer spoke — an error code alone
     * cannot (our refusals carry no `code` at all).
     */
    async function trackedHandshake(opts: tls.ConnectionOptions): Promise<Attempt> {
      const inner = opts.checkServerIdentity
      if (!inner) throw new Error('trackedHandshake needs the pinned identity callback')
      let identityChecked = false
      const r = await handshake({
        ...opts,
        checkServerIdentity: (host, cert) => {
          identityChecked = true
          return inner(host, cert)
        },
      })
      return { ...r, identityChecked }
    }

    // ── the three states, measured directly against OpenSSL ────────────────
    // Same three the fix was derived from on the live server, reproduced here
    // without a network. They are asserted on raw contexts rather than through
    // buildTlsOptions on purpose: state (1) is no longer reachable from
    // production code, and it is the state that explains the bug.

    it('(1) an anchored LEAF cannot end the chain without the flag — and the pin is never compared', async () => {
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const r = await rawHandshake({ ca: [PRIVATE_LEAF_CERT] })
      expect(r.ok).toBe(false)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('SELF_SIGNED_CERT_IN_CHAIN')
      // The whole user-visible defect in one assertion: the pin callback never
      // ran, so no pin — correct or not — could have changed the outcome.
      expect(r.identityChecked).toBe(false)
    })

    it('(2) with the flag the anchored LEAF ends the chain and the pin callback DOES run', async () => {
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const r = await rawHandshake({ ca: [PRIVATE_LEAF_CERT], allowPartialTrustChain: true })
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
      expect(r.identityChecked).toBe(true)
    })

    it('(3) the flag alone trusts nothing — without the anchor the chain still fails', async () => {
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      // An unrelated anchor, so the list is non-empty and the only difference
      // from (2) is WHICH certificate is in it.
      const r = await rawHandshake({ ca: [SELF_SIGNED_CERT], allowPartialTrustChain: true })
      expect(r.ok).toBe(false)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('SELF_SIGNED_CERT_IN_CHAIN')
      expect(r.identityChecked).toBe(false)
    })

    // ── the same through the production path ───────────────────────────────

    it('pinned + anchored PEM → handshake SUCCEEDS (this is the defect being fixed)', async () => {
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      expect(opts.rejectUnauthorized).toBe(true)
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('pinned WITHOUT the certificate PEM → still fails closed', async () => {
      // Unchanged: the flag rides on the anchors, so a fingerprint-only pin
      // gets no help from it. Until the recovery dialog persists the body, a
      // private-CA server errors like any untrusted chain.
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        servername: 'mail.private.test',
      })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('anchored leaf keeps skipping the hostname check — identity mode is unchanged', async () => {
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'not-the-pinned-host.example',
      })!
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    // ── the flag did NOT buy the private CA any standing ───────────────────

    it('a DIFFERENT certificate from the same private CA is refused as a pin mismatch (root in the OS store)', async () => {
      // The machine in the incident has the private root installed, so the
      // chain verifies on its own and `checkServerIdentity` is reached. What
      // must stop the connection is the pin, and nothing else.
      osStoreContains([PRIVATE_ROOT_CERT])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(r.error?.message).toContain('TLS pin mismatch')
      expect(r.error?.message).toContain(PRIVATE_LEAF2_FP)
    })

    it('an ORPHANED intermediate in the OS store lets the chain verify — the per-certificate hold is what refuses', async () => {
      // Now only the INTERMEDIATE sits in the OS store, with no root above it
      // — the real shape on the affected machine (`Russian_Trusted_Sub_CA*` in
      // /usr/local/share/ca-certificates/). The flag promotes every
      // non-self-signed member of the trust list to a standalone end of trust,
      // so this rotated certificate DOES verify: the trust list is not reduced,
      // and OpenSSL therefore has no objection to raise.
      //
      // That is design B's premise, not a gap in it. `allowPartialTrustChain`
      // is a property of the CONTEXT while the decision it could corrupt is
      // taken per PRESENTED certificate, so containment lives in the layer that
      // can see the certificate. Here the presented leaf is not pinned at all,
      // so the connection fails closed one layer down, as a pin mismatch — and
      // that verdict is what re-raises the recovery dialog for it.
      osStoreContains([PRIVATE_SUB_CERT])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.ok).toBe(false)
      expect(isTlsTrustError(r.error)).toBe(true)
      // WHO refused: the chain verified (so the promotion really did happen —
      // this is the measurement, not an assumption) and the pin comparison ran.
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin mismatch')
      expect(r.error?.message).toContain(PRIVATE_LEAF2_FP)
      // Our refusals carry no OpenSSL code; a chain verdict here would mean the
      // hold was never reached and the test proved nothing about it.
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined()
    })

    it('the ANCHORED leaf still connects with nothing usable in the store', async () => {
      // The control for the test above, and the regression guard for the
      // incident fix: with the store's only entry an orphaned intermediate
      // that cannot anchor this chain, the leaf the user confirmed must still
      // terminate its own chain.
      osStoreContains([PRIVATE_SUB_CERT])
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('MIXED endpoint with an ORPHANED intermediate — the fingerprint-only leaf gains NOTHING from the flag', async () => {
      // The invariant this pins, and the reason it is expressed per presented
      // certificate: `partialChain` is a property of the CONTEXT (the whole
      // trust list) while the anchored/fingerprint-only discrimination is a
      // property of the PRESENTED certificate, so on an endpoint holding both
      // kinds of pin the relaxed chain building reaches the fingerprint-only
      // leaf too — here it verifies against a bare intermediate, a chain that
      // before the flag could not terminate at all.
      //
      // The hostname MATCHES here, so neither the chain nor the name check can
      // be what refuses this connection. What refuses it is the hold: this
      // endpoint holds a human-confirmed BODY, and only confirmed bodies are
      // accepted on it. Design A tried to hold the same line by composing the
      // trust list and could not — an anchor that is itself a CA (see the
      // regression test below) is appended after any filter by construction.
      osStoreContains([PRIVATE_SUB_CERT])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP, PRIVATE_LEAF2_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.ok).toBe(false)
      // WHO refused: the chain verified, the pin was found, the BODY was not.
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin not confirmed')
      expect(r.error?.message).toContain(PRIVATE_LEAF2_FP)
      expect(r.error?.message).not.toContain('TLS pin mismatch')
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined()
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('the partial-chain trust list is the whole snapshot plus the anchors — nothing is reduced', async () => {
      // The composition design B hands to OpenSSL, asserted on the list itself
      // because the handshake tests can only show consequences. Both store
      // entries survive — the self-signed private ROOT and the bare Sub CA
      // alike — and the anchor is appended to them. Containment is NOT here;
      // it is in `checkServerIdentity` (the tests above), which is why this
      // list may stay complete.
      osStoreContains([PRIVATE_ROOT_CERT, PRIVATE_SUB_CERT])
      const seen: Array<{ ca?: string[]; partialChain?: boolean }> = []
      vi.spyOn(tls, 'createSecureContext').mockImplementation(((
        opts?: tls.SecureContextOptions & { allowPartialTrustChain?: boolean },
      ) => {
        seen.push({ ca: opts?.ca as string[] | undefined, partialChain: opts?.allowPartialTrustChain })
        return { __stub: true } as unknown as tls.SecureContext
      }) as typeof tls.createSecureContext)

      buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })
      expect(seen[seen.length - 1]).toEqual({
        ca: [PRIVATE_ROOT_CERT, PRIVATE_SUB_CERT, PRIVATE_LEAF_CERT],
        partialChain: true,
      })

      // Control: with no anchor there is no flag at all, and the list is the
      // snapshot untouched — the unpinned path is bit-for-bit what it was.
      __resetCombinedCaCacheForTest()
      buildTlsOptions({ tlsPinsSha256: [PRIVATE_LEAF_FP], servername: 'mail.private.test' })
      expect(seen[seen.length - 1]).toEqual({
        ca: [PRIVATE_ROOT_CERT, PRIVATE_SUB_CERT],
        partialChain: undefined,
      })
    })

    it('a store intermediate keeps its chain-LINK role on the pinned context', async () => {
      // The coverage design A gave up and design B keeps, so it gets a test:
      // reducing the list to its self-signed subset also removed the ORDINARY
      // role of a store intermediate — supplying a link the server omitted.
      //
      // Server sends the leaf ALONE (a common misconfiguration); the user's
      // store carries Sub CA + private root. The chain can only verify by
      // using the store's intermediate as a LINK, and it must, even though
      // this endpoint is pinned and runs the partial-chain context. Proof that
      // it did: the pin callback was reached at all.
      osStoreContains([PRIVATE_ROOT_CERT, PRIVATE_SUB_CERT])
      server = tls.createServer(
        { key: PRIVATE_LEAF2_KEY, cert: PRIVATE_LEAF2_CERT },
        (socket) => socket.end('OK\r\n'),
      )
      server.on('tlsClientError', () => {})
      port = await listenLocal(server)

      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.identityChecked).toBe(true)
      // Refused by the pin, not by the chain: the link worked, the certificate
      // is simply not the confirmed one.
      expect(r.ok).toBe(false)
      expect(r.error?.message).toContain('TLS pin mismatch')
    })

    it('an intermediate in the OS store does NOT become an end of trust on the unpinned path', async () => {
      // The control for the test above, and the reason the flag is scoped to
      // the pinned context: the identical trust store, with no pin to contain
      // the widening, must still refuse this chain.
      osStoreContains([PRIVATE_SUB_CERT])
      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({ servername: 'mail.private.test' })!
      expect(opts.checkServerIdentity).toBeUndefined()
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      // WHICH chain-building code comes back is OpenSSL's business and differs
      // with the trust set (measured: UNABLE_TO_GET_ISSUER_CERT here, where the
      // untrusted intermediate is present but cannot anchor; SELF_SIGNED_CERT_IN_CHAIN
      // when it is absent). The assertion is that the chain is REFUSED and that
      // the failure classifies as a trust error, not a particular code.
      expect(isTlsTrustError(r.error)).toBe(true)
      expect(['UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']).toContain(
        (r.error as NodeJS.ErrnoException | undefined)?.code,
      )
    })

    it('MIXED endpoint — the fingerprint-only leaf is refused before the hostname check can matter', async () => {
      // An anchored pin (from the recovery dialog) and a fingerprint-only pin
      // (renderer-writable `tls:addPin`) on one endpoint; the server presents
      // the fingerprint-only one, and its name does NOT match the dialled
      // host. Both layers would refuse it, so the assertion is about WHICH:
      // on a partial-chain context the hold speaks first and the name check
      // never runs, because the name is not what the guarantee rests on here.
      osStoreContains([PRIVATE_ROOT_CERT])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP, PRIVATE_LEAF2_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'not-the-pinned-host.example',
      })!
      const r = await trackedHandshake(opts)
      expect(r.ok).toBe(false)
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin not confirmed')
      expect(r.error?.message).not.toMatch(/altnames|subject/i)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined()
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    // ── the case design B exists for: an anchor that is itself a CA ─────────
    //
    // The finding that retired design A. A confirmed anchor need not be a
    // leaf: `net:trustCert` stores the certificate the endpoint PRESENTED, and
    // a server can present a CA certificate (`basicConstraints: CA:TRUE`).
    // With the partial-chain flag such an anchor terminates the chain of every
    // certificate it ever issued — and no filtering of the OS store can help,
    // because anchors are appended AFTER any filter, by construction.
    //
    // So the guarantee is held per presented certificate instead: on an
    // endpoint that holds a confirmed body, only confirmed bodies are
    // accepted. These two tests are that guarantee, over real handshakes.

    it('a CA anchor does not launder its own descendants — a fingerprint-only descendant is refused', async () => {
      // The user confirmed the Sub CA (it is what this endpoint presented at
      // the time); a compromised renderer then pins a leaf ISSUED by that Sub
      // CA through `tls:addPin`, with no body. The hostname MATCHES, and the
      // chain verifies through the anchor — so without the hold this
      // certificate would be accepted as the mail host although the human
      // confirmed a different one. That is the MITM design A could not close.
      osStoreContains([])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_SUB_FP, PRIVATE_LEAF2_FP],
        tlsPinnedCertsPem: [PRIVATE_SUB_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.ok).toBe(false)
      // The chain DID verify through the CA anchor — measured, not assumed.
      // That is precisely why containment cannot live in the trust list.
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin not confirmed')
      expect(r.error?.message).toContain(PRIVATE_LEAF2_FP)
      expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined()
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('a descendant of a CA anchor that is not pinned at all is refused as a mismatch', async () => {
      // Same endpoint, same verifying chain, but nothing pinned the presented
      // leaf: the refusal comes one step earlier and names the other verdict.
      // Both messages must stay distinguishable — a log has to say whether the
      // pin was unknown or merely unconfirmed.
      osStoreContains([])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_SUB_FP],
        tlsPinnedCertsPem: [PRIVATE_SUB_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.ok).toBe(false)
      expect(r.identityChecked).toBe(true)
      expect(r.error?.message).toContain('TLS pin mismatch')
      expect(r.error?.message).toContain(PRIVATE_LEAF2_FP)
      expect(r.error?.message).not.toContain('TLS pin not confirmed')
      expect(isTlsTrustError(r.error)).toBe(true)
    })

    it('a CONFIRMED descendant of the same CA anchor still connects — the hold narrows, it does not break the dialog', async () => {
      // Control for the pair above: the hold refuses UNCONFIRMED bodies, not
      // "everything the CA anchor issued". Once the same descendant is
      // confirmed in the recovery dialog — i.e. its body is stored alongside
      // its pin — the very same endpoint accepts it. That is the remedy the
      // price is paid against, so it gets a test of its own.
      osStoreContains([])
      await serve(PRIVATE_LEAF2_CERT, PRIVATE_LEAF2_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_SUB_FP, PRIVATE_LEAF2_FP],
        tlsPinnedCertsPem: [PRIVATE_SUB_CERT, PRIVATE_LEAF2_CERT],
        servername: 'mail.private.test',
      })!
      const r = await trackedHandshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
      expect(r.identityChecked).toBe(true)
    })

    // ── combined CA store entirely unavailable (not merely lacking the ──────
    // private root) — `combined === null`, `ca` is built from the anchor
    // alone. Unit tests above prove the FLAG turns on in this branch; only a
    // real handshake proves the chain actually terminates on the anchor and
    // that the pin, not the (absent) system store, is what still guards it.

    it('combined CA store entirely unavailable + anchored pin → handshake still succeeds via the anchor alone', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: [PRIVATE_LEAF_FP],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await handshake(opts)
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
    })

    it('combined CA store entirely unavailable + anchored pin → a WRONG recorded fingerprint is still refused', async () => {
      // The anchor makes the chain verify (so `checkServerIdentity` runs at
      // all); with no system store to fall back on, fingerprint equality is
      // the ONLY thing left that can still refuse a certificate here.
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(tls, 'getCACertificates').mockImplementation((() => {
        throw new Error('unavailable')
      }) as typeof tls.getCACertificates)

      await serve(PRIVATE_LEAF_CERT, PRIVATE_LEAF_KEY)
      const opts = buildTlsOptions({
        tlsPinsSha256: ['00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'],
        tlsPinnedCertsPem: [PRIVATE_LEAF_CERT],
        servername: 'mail.private.test',
      })!
      const r = await handshake(opts)
      expect(r.ok).toBe(false)
      expect(r.error?.message).toContain('TLS pin mismatch')
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
      port = await listenLocal(server)
    })

    afterEach(async () => {
      await closeServer(server)
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
