/**
 * A readable reason for a TLS certificate failure, for display only.
 *
 * Built from the error CODE (OpenSSL verify codes and Node's
 * `ERR_TLS_CERT_ALTNAME_INVALID` are authoritative), with the message as a
 * fallback for libraries that surface only the text. The raw message is never
 * shown to the user: Node appends runtime advice to some of them ("try running
 * Node.js with --use-system-ca") that does not apply to this application.
 *
 * This decides nothing about trust. Whether a connection is refused, pinned or
 * offered for confirmation is `isTlsTrustError` and the pin verifier in
 * packages/net/tls.ts; this only names the failure on the dialog.
 */

export const CERT_FAILURE_REASONS = [
  'expired',
  'notYetValid',
  'selfSigned',
  'unknownIssuer',
  'nameMismatch',
  'revoked',
  'pinMismatch',
  'untrusted',
  'unknown',
] as const

export type CertFailureReason = (typeof CERT_FAILURE_REASONS)[number]

export const CERT_FAILURE_REASON_BY_CODE: Readonly<Record<string, CertFailureReason>> = {
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'notYetValid',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'selfSigned',
  SELF_SIGNED_CERT_IN_CHAIN: 'selfSigned',
  UNABLE_TO_GET_ISSUER_CERT: 'unknownIssuer',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unknownIssuer',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unknownIssuer',
  ERR_TLS_CERT_ALTNAME_INVALID: 'nameMismatch',
  HOSTNAME_MISMATCH: 'nameMismatch',
  CERT_REVOKED: 'revoked',
  CERT_UNTRUSTED: 'untrusted',
  CERT_REJECTED: 'untrusted',
  CERT_SIGNATURE_FAILURE: 'untrusted',
  CERT_CHAIN_TOO_LONG: 'untrusted',
}

// Ordered: the first match wins, and `self-signed certificate in certificate
// chain` must not be read as an issuer problem. Every pattern is a full phrase.
const REASON_BY_MESSAGE: ReadonlyArray<readonly [RegExp, CertFailureReason]> = [
  [/certificate has expired/i, 'expired'],
  [/certificate is not yet valid/i, 'notYetValid'],
  [/self[- ]signed certificate/i, 'selfSigned'],
  [/unable to verify the first certificate|unable to get (?:local )?issuer certificate/i, 'unknownIssuer'],
  [/hostname\/ip does not match certificate's (?:altnames|subject)/i, 'nameMismatch'],
  [/certificate (?:is )?revoked/i, 'revoked'],
  [/TLS pin (?:mismatch|not confirmed|error)/i, 'pinMismatch'],
  [/certificate is not trusted|certificate signature failure|certificate chain too long/i, 'untrusted'],
]

export function classifyCertFailureReason(err: unknown): CertFailureReason {
  const rawCode = (err as { code?: unknown } | null | undefined)?.code
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : ''
  const byCode = CERT_FAILURE_REASON_BY_CODE[code]
  if (byCode) return byCode
  const message = err instanceof Error ? err.message : String(err ?? '')
  for (const [re, reason] of REASON_BY_MESSAGE) if (re.test(message)) return reason
  return 'unknown'
}

/** Narrow an untrusted value to the closed set (anything else reads as unknown). */
export function toCertFailureReason(value: unknown): CertFailureReason {
  return (CERT_FAILURE_REASONS as readonly unknown[]).includes(value) ? (value as CertFailureReason) : 'unknown'
}
