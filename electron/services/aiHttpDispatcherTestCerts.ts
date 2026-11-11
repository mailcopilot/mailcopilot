/**
 * Shared test-only TLS fixture for `aiHttpDispatcher.*.test.ts`.
 *
 * Not itself a test file (no `.test.ts` suffix — vitest's default include
 * glob will not pick it up as a suite). Extracted here because TWO suites
 * need the same chain: `aiHttpDispatcher.test.ts` and
 * `aiHttpDispatcher.streaming.test.ts` both stand up a live HTTPS server that
 * presents this leaf, and keeping one copy of the PEM blocks means there is
 * only one place a regenerated chain could drift out of sync with the other.
 *
 * ROOT is a self-signed CA ("MailCopilot Test-Only AI Root"); LEAF is
 * CN=localhost, SAN DNS:localhost + IP:127.0.0.1, signed by ROOT. Both valid
 * until 2126. Generated once with openssl and embedded so the suites need
 * neither the openssl binary nor keygen at run time (same pattern as
 * `packages/net/safeRemoteFetch.test.ts`).
 */
export const ROOT_CERT = `-----BEGIN CERTIFICATE-----
MIIBtzCCAV2gAwIBAgIUQJI7zk8ne/pzHXx3UMT5QYdGn3QwCgYIKoZIzj0EAwIw
KDEmMCQGA1UEAwwdTWFpbENvcGlsb3QgVGVzdC1Pbmx5IEFJIFJvb3QwIBcNMjYw
OTE2MDkxNzI2WhgPMjEyNjA4MjMwOTE3MjZaMCgxJjAkBgNVBAMMHU1haWxDb3Bp
bG90IFRlc3QtT25seSBBSSBSb290MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
o8FQ0gEeSGZtuAkFCcNeoopgalH4IIUXZwWbo19OVqIlAyQdm2m8DtuxRMvanOzW
ZE5zjXcsowH5diPB7zM7KaNjMGEwHQYDVR0OBBYEFNoQZSUPuA/9dmOQUtRgw+DG
rZPZMB8GA1UdIwQYMBaAFNoQZSUPuA/9dmOQUtRgw+DGrZPZMA8GA1UdEwEB/wQF
MAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQDeAJzO228c
ZymGd1/KdclWazMoHSV/QRaonNpvTW99QgIgdMKuwtcO6QMUtK8U+Ve62Zy7h5oD
PWzkNAEJg+Ak778=
-----END CERTIFICATE-----
`

export const LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIB0zCCAXmgAwIBAgIUT7AI5OOkYzHlD5coFrs7bDg/DUAwCgYIKoZIzj0EAwIw
KDEmMCQGA1UEAwwdTWFpbENvcGlsb3QgVGVzdC1Pbmx5IEFJIFJvb3QwIBcNMjYw
OTE2MDkxNzI2WhgPMjEyNjA4MjMwOTE3MjZaMBQxEjAQBgNVBAMMCWxvY2FsaG9z
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABHO8rfv54OvFJi4AfWGxkrL063vu
K7DWJb/pnl6PysLU3jF7P2ovOTwLjjfh6kDNwOgtBdXymUdRZ3eVywLKUoKjgZIw
gY8wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMB0GA1UdDgQWBBQGfvmQ
u+lcBo/3DiAq2RDD74hKLTAfBgNVHSMEGDAWgBTaEGUlD7gP/XZjkFLUYMPgxq2T
2TAKBggqhkjOPQQDAgNIADBFAiAGpIJMUpogH4KaNwi4wt2wqfVUuqI2VPriuTZP
vrU5SAIhAJ7tPtYn3wpRrAnNtJrT++gKLuj6gCBPEVT5IuJGUrVH
-----END CERTIFICATE-----
`

export const LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpujLEuLq3+IQh0pe
89fPxhBctmqPD9jBLq/uGy80/tShRANCAARzvK37+eDrxSYuAH1hsZKy9Ot77iuw
1iW/6Z5ej8rC1N4xez9qLzk8C4434epAzcDoLQXV8plHUWd3lcsCylKC
-----END PRIVATE KEY-----
`

/** Walks `cause` chains (undici wraps the TLS error in `TypeError: fetch failed`). */
export function errorCodes(err: unknown): string[] {
  const codes: string[] = []
  let cur: unknown = err
  for (let i = 0; cur && i < 5; i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    cur = (cur as { cause?: unknown }).cause
  }
  return codes
}
