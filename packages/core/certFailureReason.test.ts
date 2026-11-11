import { describe, expect, it } from 'vitest'
import { CERT_FAILURE_REASONS, classifyCertFailureReason, toCertFailureReason } from './certFailureReason'

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code })

describe('classifyCertFailureReason', () => {
  it.each([
    ['CERT_HAS_EXPIRED', 'expired'],
    ['CERT_NOT_YET_VALID', 'notYetValid'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'selfSigned'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'selfSigned'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unknownIssuer'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unknownIssuer'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'nameMismatch'],
    ['CERT_REVOKED', 'revoked'],
    ['CERT_UNTRUSTED', 'untrusted'],
  ])('%s -> %s, whatever the message says', (code, reason) => {
    expect(classifyCertFailureReason(withCode(code, 'unrelated text'))).toBe(reason)
  })

  it('reads the code case-insensitively', () => {
    expect(classifyCertFailureReason(withCode('cert_has_expired'))).toBe('expired')
  })

  it('falls back to the message when the library kept only the text', () => {
    expect(classifyCertFailureReason(new Error('LOGIN aborted: self-signed certificate'))).toBe('selfSigned')
    expect(classifyCertFailureReason(new Error('self-signed certificate in certificate chain'))).toBe('selfSigned')
    expect(classifyCertFailureReason(new Error('certificate has expired'))).toBe('expired')
    expect(classifyCertFailureReason(new Error("Hostname/IP does not match certificate's altnames: Host: a. is not in the cert's altnames"))).toBe('nameMismatch')
    expect(classifyCertFailureReason(new Error('TLS pin mismatch'))).toBe('pinMismatch')
  })

  it('names the Node runtime advice case by its code, not by that advice', () => {
    const err = withCode(
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'unable to get local issuer certificate. If the issue is related to missing system CAs, try running Node.js with --use-system-ca',
    )
    expect(classifyCertFailureReason(err)).toBe('unknownIssuer')
  })

  it('unrecognised or non-error input reads as unknown', () => {
    expect(classifyCertFailureReason(new Error('something else'))).toBe('unknown')
    expect(classifyCertFailureReason(undefined)).toBe('unknown')
    expect(classifyCertFailureReason('x')).toBe('unknown')
  })
})

describe('toCertFailureReason', () => {
  it('passes the closed set and maps everything else to unknown', () => {
    for (const r of CERT_FAILURE_REASONS) expect(toCertFailureReason(r)).toBe(r)
    expect(toCertFailureReason('expired; DROP')).toBe('unknown')
    expect(toCertFailureReason(undefined)).toBe('unknown')
  })
})
